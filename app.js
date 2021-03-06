const mongoClient = require('mongodb').MongoClient;
const async = require('async');
const sharp = require('sharp');
const {CronJob} = require('cron');
const fileType = require('file-type');
const uaParserJs = require('ua-parser-js');
const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const config = require('./config');
const Image = require('./class/image');

/************ Configuration ******************/
//mongo connection
let log;
if(config.log.enable) {
	let connectionString = `${config.db.type}db://`;
	if(config.db.username || config.db.password)
		connectionString += `${config.db.username}:${config.db.password}@`;
	connectionString += `${config.db.server}:${config.db.port}/${config.db.name}`;
	mongoClient.connect(connectionString, (err, db) => {
		if(err) throw err;
		log = db.collection('log');
	});
}

/************ Private function ******************/
/*
 @format http://192.168.1.105:3015/<app-name>/<file-type>/<directory-path>/<options>/<file-name>
 @example http://192.168.1.105:3015/demo/image/upload/Desert.jpg
 */

//send response
function sendResponse(req, res, next, buffer, crop = false) {
	//create image manipulation object
	new Promise((resolve, reject) => {
		if(crop) {
			new Image(crop)
				.manipulateImage(buffer)
				.then(resolve)
				.catch(reject);
		} else resolve(buffer);
	}).then((buf) => {
		const agent = uaParserJs(req.headers['user-agent']);
		agent.browser.name = agent.browser.name ? agent.browser.name.toLowerCase() : null;
		new Promise((resolve, reject) => {
			if(agent.browser.name === 'chrome' ||
					agent.browser.name === 'opera' ||
					agent.browser.name === 'android') {
				sharp(buf)
					.toFormat(sharp.format.webp)
					.toBuffer()
					.then(resolve)
					.catch(reject);
			} else resolve(buf);
		}).then((b) => {
			const fType = fileType(b);
			const headers = {
				'Content-Type': fType ? fType.mime : 'text/plain',
				'Content-Length': b.length
			};
			if(config.cache.enable) {
				headers['Cache-Control'] = `public, max-age=${config.cache.maxAge / 1000}`;
				headers.Expires = new Date(Date.now() + config.cache.maxAge).toUTCString();
				headers.ETag = `W/${crypto.createHash('md4').update(req.url).digest('hex')}`;
			}
			res.writeHead(200, headers);
			res.end(b, 'binary');
		}).catch(console.log);
	}).catch(console.log);
}

//routing method
function routes() {
	return function(req, res, next) {
		if(req.method === 'GET') {
			const requestUrl = url.parse(req.url);
			let parseUrl = requestUrl.pathname.replace(/^\/|\/$/g, '');
			parseUrl = parseUrl.split('/');
			let f = parseUrl[parseUrl.length - 1];

			//add protocol, if not
			if(f.indexOf('http'))
				f = `http%3A${f}`;

			try {
				f = decodeURIComponent(f);
			} catch (e) {}

			//validate either link or name
			const link = url.parse(f);
			const fName = f.substring(f.lastIndexOf('/'));
			const fPath = `${config.base}${parseUrl[2]}/${fName}`;
			const adapter = link.protocol.toLowerCase().slice(0, -1) === 'https' ? https : http;

			//download image
			if(link.hostname) {
				async.parallel([
					function(cbk) {
						adapter.request({method: 'HEAD', hostname: link.hostname, port: link.port, path: link.path},
							(resp) => {
								cbk(null, resp.headers);
							}).on('error', (e) => {
								cbk(e, null);
							}).end();
					},
					function(cbk) {
						fs.stat(fPath, (err, resp) => {
							if(err) cbk(null, null);
							else cbk(null, resp);
						});
					}
				], (err, resp) => {
					if(resp && resp[0]) {
						if(resp[1] && Number(resp[0]['content-length']) === resp[1].size) {
							//deliver remote file local copy
							fs.readFile(fPath, (err2, data) => {
								sendResponse(req, res, next, data, parseUrl.length > 4 ? {
									option: parseUrl[parseUrl.length - 2]
								} : false);
							});
						} else {
							const file = fs.createWriteStream(fPath);
							adapter.get(f, (response) => {
								if(response.statusCode === 200) {
									const data = [];
									response.pipe(file);
									response.on('data', (chunk) => {
										data.push(chunk);
									});

									file.on('error', (e) => {
										fs.unlink(fPath);
										sendResponse(req, res, next, `Got error: ${e.message}`);
									}).on('finish', () => {
										file.close();
										sendResponse(req, res, next, Buffer.concat(data), parseUrl.length > 4 ? {
											option: parseUrl[parseUrl.length - 2]
										} : false);
									});
								} else
									sendResponse(req, res, next, 'Remote file missing.');
							});
						}
					} else
						sendResponse(req, res, next, 'Remote file missing.');
				});
			} else {
				//deliver local file
			}

			//log hook
			if(config.log.enable) {
				res.once('finish', () => {
					const saveObj = {
						url: `${req.headers.host}${req.url}`,
						ip: req.connection.remoteAddress || req.socket.remoteAddress
						|| (req.connection.socket && req.connection.socket.remoteAddress),
						token: req.headers.token,
						agent: req.headers['user-agent'],
						created: new Date()
					};

					if(config.log.ttl)
						saveObj.ttl = new Date(new Date().getTime() + config.log.ttl);
					log.insertOne(saveObj, {w: config.db.writeConcern});
				});
			}
		} else {
			//method not allowed
			res.statusCode = 405;
			res.setHeader('Allow', 'GET');
			res.setHeader('Content-Length', '0');
			res.end();
		}
	};
}

/*********Initialize Server**********************/
let serv;
if(typeof process.env.HTTP === 'undefined' || process.env.HTTP)
	serv = http.createServer(routes());
else {
	serv = https.createServer({
		key: fs.readFileSync(config.server.ssl.key),
		cert: fs.readFileSync(config.server.ssl.cert),
		ca: fs.readFileSync(config.server.ssl.ca)
	}, routes());
}

serv.timeout = config.server.timeout;
serv.listen(process.env.PORT || config.port, config.host, () => {
	console.log(`Server initialize http${(process.env.HTTP === 'false' ? 's' : '')}://${config.host}:\
${process.env.PORT || config.port}`);

	//setup cron job
	new CronJob('00 00 * * * *', () => {
		fs.readdir(config.base, (err, list) => {
			if(list && list.length) {
				async.concatSeries(list, (dir, cbk) => {
					fs.readdir(`${config.base}${dir}`, (err2, f) => {
						if(f && f.length) {
							async.mapLimit(f, 5, (file, cbk2) => {
								fs.stat(`${config.base}${dir}/${file}`, (err3, stats) => {
									if(stats && stats.mtime &&
										(new Date(stats.mtime).getTime() + config.cache.maxAge) <
										new Date().getTime())
										fs.unlink(`${config.base}${dir}/${file}`, cbk2);
									else cbk2(null);
								});
							}, cbk);
						} else cbk(null);
					});
				}, () => {});
			}
		});
	}, null, true);
});
