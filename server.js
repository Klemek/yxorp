const fs = require('fs');
const http = require('http');
const request = require('request');
const url = require('url');
const {Transform} = require('stream');

const DEBUG_LEVEL = 1;

const port = process.argv[2] || 5050;
let proxy = process.argv[3] || `http://localhost:${port}`;
const index = process.argv[4] || 'index.html';
const sourceHistory = {};

console.log('Loading home page...');
const html = fs.readFileSync(index);

if (!proxy.endsWith('/'))
  proxy += '/';

/**
 * Rewrite URL to add proxy before it
 * @param {string} prefix - to add before URL
 * @param {string} u - the url to rewrite
 * @param {string} suffix - to add after URL
 * @param {string} targetUrl - URL of the current page
 * @returns {string}
 */
const rewriteUrl = (prefix, u, suffix, targetUrl) => {
  let parsedUrl = url.parse(targetUrl);
  let protocol = parsedUrl.protocol;
  let targetOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  if (/^\w+:\/\//gi.test(u)) { // full URL with protocol (https://google.com/favicon.ico)
    return prefix + proxy + u + suffix; // simply add proxy
  } else if (u.startsWith('//')) { // full URL without protocol (//google.com/favicon.ico)
    return prefix + proxy + protocol + u + suffix; // add proxy and protocol
  } else if (u.startsWith('/')) { // URL with root path (/favicon.ico)
    return prefix + proxy + targetOrigin + u + suffix; // add proxy and origin (https://google.com)
  } else { // relative path (favicon.ico)
    return prefix + u + suffix; // keep it that way
  }
};

/**
 * Change a string by applying a transform on regex matches
 * @param {string} input
 * @param {RegExp} regex
 * @param {function(RegExpMatchArray):string} transform
 * @returns {string}
 */
const changeByRegex = (input, regex, transform) => {
  const matches = input.matchAll(regex);
  let output = '';
  let i = 0;
  let frag;
  for (const match of matches) {
    if (DEBUG_LEVEL >= 2)
      console.log('-' + match[0]);
    frag = transform(match);
    if (DEBUG_LEVEL >= 2)
      console.log('+', frag);
    output += input.substr(i, match.index - i) + frag;
    i = match.index + match[0].length;
  }
  output += input.substr(i);
  return output;
};

/**
 * Create a special Stream Transform that accumulate data
 * @param {function(string):string} finalTransform
 * @returns {module:stream.internal.Transform}
 */
const contentTransform = (finalTransform) => {
  const stream = new Transform();
  let input = '';
  // simply accumulate data
  stream._transform = (chunk, enc, next) => {
    if (chunk) {
      input += chunk;
      next(null, null);
    }
  };
  // on flush, change content and send
  stream._flush = (next => {
    next(null, finalTransform(input));
  });
  return stream;
};

/**
 * Stream Transform to rewrite HTML known URLs
 * @param {string} targetUrl - current page URL
 * @returns {module:stream.internal.Transform}
 */
const htmlTransform = (targetUrl) => contentTransform(input => {
  // change HTML attributes as href= or src=
  let output1 = changeByRegex(input, /(href|src|url)=["']([^"']+)["']/gm,
    m => rewriteUrl(`${m[1]}="`, m[2], '"', targetUrl));
  // removes script integrity attributes
  let output2 = changeByRegex(output1, /(integrity)=["']([^"']+)["']/gm,
    () => '');
  // change CSS attributes that uses url(...)
  return changeByRegex(output2, /url\(([^)]*)\)/gm,
    m => rewriteUrl('url(', m[1], ')', targetUrl));
});

/**
 * Stream Transform to rewrite CSS known URLs
 * @param {string} targetUrl - current page URL
 * @returns {module:stream.internal.Transform}
 */
const cssTransform = (targetUrl) => contentTransform(input => changeByRegex(input, /url\(([^)]*)\)/gm,
  m => rewriteUrl('url(', m[1], ')', targetUrl)));

/**
 * Stream Transform to rewrite any URLs found
 * @param {string} targetUrl - current page URL
 * @returns {module:stream.internal.Transform}
 */
/*const basicTransform = (targetUrl) => contentTransform(input => changeByRegex(input, /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])?/gm,
  m => rewriteUrl('', m[0], '', targetUrl)));*/

/**
 * Core of the proxy, will send the request and compute the result
 * @param req
 * @param res
 */
const proxyRequest = (req, res) => {
  const source = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const reqUrl = url.parse(req.url); // keep requested URL
  req.url = 'https://' + req.url;
  const targetHost = url.parse(req.url).host; // extract target host
  try {
    if (DEBUG_LEVEL >= 1)
      console.log(`${source}>${req.method} ${req.url}`);
    // change request headers to avoid issues
    req.headers['host'] = targetHost;
    delete req.headers['accept-encoding'];
    // pipe original request to a new one
    req.pipe(request(req.url)
      .on('error', () => {
        // targetHost is last request, normal error
        if (req.redirect > 2 || sourceHistory[source] === targetHost) {
          console.error(`${source}!>${req.method} ${req.url}`);
          res.writeHead(500, 'internal error', {"Content-Type": "text/plain"});
          res.end();
        } else { // else try to redirect to known host
          req.url = sourceHistory[source] + '/' + reqUrl.pathname;
          proxyRequest(req, res);
        }
      })
      .on('response', r => {
        let contentType = (r.headers['content-type'] || 'unknown').split(';')[0];
        if (DEBUG_LEVEL >= 1)
          console.log(`${source}<${r.statusCode} (${contentType}) ${req.url}`);
        sourceHistory[source] = targetHost;
        if (!r.headers['content-type']) // unknown content, just send it as-is
          return r.pipe(res);
        // remove troublesome headers
        delete r.headers['access-control-allow-origin'];
        delete r.headers['content-security-policy'];
        delete r.headers['content-length'];
        // write correct response head
        res.writeHead(res.statusCode, r.headers);
        // change data by content-type
        switch (contentType) {
          case 'text/html':
            r.pipe(htmlTransform(req.url)).pipe(res);
            break;
          case 'text/css':
            r.pipe(cssTransform(req.url)).pipe(res);
            break;
          case 'text/javascript':
          case 'application/javascript':
          case 'application/json':
          case 'text/xml':
          case 'application/xml':
          case 'application/xhtml+xml':
          // TODO breaking some JS, need to refine
          //r.pipe(basicTransform(req.url)).pipe(res);
          //break;
          default:
            // simply send data without change
            r.pipe(res);
            break;
        }
      }));
  } catch (e) {
    // invalid URI issue
    console.error(`${source}!!>${req.method} ${req.url}`);
    res.writeHead(500, 'internal error', {"Content-Type": "text/plain"});
    res.end();
  }
};

console.log('Creating server...');
const server = http.createServer((req, res) => {
  if (req.url === '/') { // on root path, send index
    res.writeHead(200, {"Content-Type": "text/html"});
    res.write(html);
    res.end();
  } else { // redirect to URL
    req.url = req.url.substr(1);
    const reqUrl = url.parse(req.url);
    if (reqUrl.protocol != null) {
      res.writeHead(308, {"Location": reqUrl.slashes ? '/' + reqUrl.host + reqUrl.path : reqUrl.path});
      res.end();
    } else {
      proxyRequest(req, res);
    }
  }
});

console.log(`yxorp started at ${proxy}`);
server.listen(port);