const fs = require('fs');
const http = require('http');
const request = require('request');
const url = require('url');
const {Transform} = require('stream');

const DEBUG = false;

const port = process.argv[2] || 5050;
let proxy = process.argv[3] || `http://localhost:${port}`;
const index = process.argv[4] || 'index.html';

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
    if(DEBUG)
      console.log('-'+match[0]);
    frag = transform(match);
    if(DEBUG)
      console.log('+',frag);
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
  let output = changeByRegex(input, /(href|src|url)=["']([^"']+)["']/gm,
    m => rewriteUrl(`${m[1]}="`, m[2], '"', targetUrl));
  // change CSS attributes that uses url(...)
  return changeByRegex(output, /url\(([^)]*)\)/gm,
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
const basicTransform = (targetUrl) => contentTransform(input => changeByRegex(input, /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])?/gm,
  m => rewriteUrl('', m[0], '', targetUrl)));

console.log('Creating server...');
const server = http.createServer((req, res) => {
  if (req.url === '/') { // on root path, send index
    res.writeHead(200, {"Content-Type": "text/html"});
    res.write(html);
    res.end();
  } else if (req.url === '/favicon.ico') { // ignore favicon
    res.writeHead(404, 'not found', {"Content-Type": "text/plain"});
    res.end();
  } else { // redirect to URL
    if (req.url.substr(0, 1) === '/') // remove the first / added by default
      req.url = req.url.substr(1);
    if (!/^\w+:\/\//gi.test(req.url)) // add protocol if not present
      req.url = 'https://' + req.url;
    if (DEBUG)
      console.log(`>${req.url}`);
    try {
      // send request to get URL data
      request({
        url: req.url
      }).on('error', () => {
        console.error(`!${req.url}`);
        res.writeHead(500, 'internal error', {"Content-Type": "text/plain"});
        res.end();
      }).on('response', r => {
        if (!r.headers['content-type']) // unknown content, just send it as-is
          return r.pipe(res);
        // remove troublesome headers
        delete r.headers['access-control-allow-origin'];
        delete r.headers['content-security-policy'];
        delete r.headers['content-length'];
        // write correct response head
        res.writeHead(res.statusCode, r.headers);
        // change data by content-type
        switch (r.headers['content-type'].split(';')[0]) {
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
      });
    } catch {
      // invalid URI issue
      console.error(`!${req.url}`);
      res.writeHead(500, 'internal error', {"Content-Type": "text/plain"});
      res.end();
    }
  }
});

console.log(`yxorp started at ${proxy}`);
server.listen(port);