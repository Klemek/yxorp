const fs = require('fs');
const http = require('http');
const request = require('request');
const url = require('url');
const {Transform} = require('stream');

const DEBUG = {
  NONE: 0,
  ERROR: 1,
  REQUEST: 2,
  RESPONSE: 4,
  HTML_MATCH: 8,
  CSS_MATCH: 16,
  SCRIPT_MATCH: 32,
  BASIC_MATCH: 64,
  REDIRECT: 128,
  INIT_REQ: 256,
};

const DEBUG_LEVEL = DEBUG.INIT_REQ;

const REMOVE_REQ_HEADERS = [
  'accept-encoding',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user'];
const REMOVE_RESP_HEADERS = [
  'access-control-allow-origin',
  'content-security-policy',
  'content-length'
];
const HISTORY_TIMEOUT = 6e5; // 10 minutes

console.log('DEBUG LEVELS :');
Object.keys(DEBUG).forEach(key => {
  if (DEBUG_LEVEL & DEBUG[key])
    console.log(' - ' + key);
});

const port = process.argv[2] || 5050;
let proxy = process.argv[3] || `http://localhost:${port}`;
const proxyHost = url.parse(proxy).host;
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
  if (u.includes(proxy)) //already treated
    return prefix + u + suffix;
  let parsedUrl = url.parse(targetUrl);
  let parsedMatch = url.parse(u);
  let targetOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  if (parsedMatch.protocol) { // full URL with protocol (https://google.com/favicon.ico)
    return prefix + proxy + parsedMatch.host + parsedMatch.path + suffix; // simply add proxy
  } else if (u.startsWith('//')) { // full URL without protocol (//google.com/favicon.ico)
    return prefix + proxy + u.substr(2) + suffix; // add proxy
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
 * @param {number} debugId
 * @returns {string}
 */
const changeByRegex = (input, regex, transform, debugId) => {
  const matches = input.matchAll(regex);
  let output = '';
  let i = 0;
  let frag;
  for (const match of matches) {
    if (DEBUG_LEVEL & debugId)
      console.log('-' + match[0]);
    frag = transform(match);
    if (DEBUG_LEVEL & debugId)
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
    m => rewriteUrl(`${m[1]}="`, m[2], '"', targetUrl), DEBUG.HTML_MATCH);
  // removes script integrity attributes
  return changeByRegex(output1, /(integrity)=["']([^"']+)["']/gm,
    () => '', DEBUG.NONE);
});

/**
 * Stream Transform to rewrite CSS known URLs
 * @param {string} targetUrl - current page URL
 * @returns {module:stream.internal.Transform}
 */
const cssTransform = (targetUrl) => contentTransform(input => changeByRegex(input, /url\(([^)]*)\)/gm,
  m => rewriteUrl('url(', m[1], ')', targetUrl), DEBUG.CSS_MATCH));

/**
 * Stream Transform to rewrite possible JS URLs
 * @param {string} targetHost - current page Host
 * @returns {module:stream.internal.Transform}
 */
const scriptTransform = (targetHost) => contentTransform(input => {
  // found domains like (//something.com/)
  let output1 = changeByRegex(input, /\/\/((\w+\.)+\w+)\//gm,
    m => '//' + proxyHost + m[0].substr(1), DEBUG.SCRIPT_MATCH);
  // found escaped domains like (\/\/something.com\/)
  return changeByRegex(output1, /\\\/\\\/((\w+\.)+\w+)\\\//gm,
    m => '\\/\\/' + proxyHost + m[0].substr(2), DEBUG.SCRIPT_MATCH);
});

/**
 * Stream Transform to rewrite any URLs found
 * @param {string} targetUrl - current page URL
 * @returns {module:stream.internal.Transform}
 */
const basicTransform = (targetUrl) => contentTransform(input => changeByRegex(input, /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])?/gm,
  m => rewriteUrl('', m[0], '', targetUrl), DEBUG.BASIC_MATCH));

/**
 * Core of the proxy, will send the request and compute the result
 * @param req
 * @param res
 */
const proxyRequest = (req, res) => {
  const source = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const time = new Date().getTime();
  // clear history if too old
  if(sourceHistory[source] && time - sourceHistory[source].time > HISTORY_TIMEOUT)
    delete sourceHistory[source];



  const reqUrl = url.parse(req.url); // keep requested URL
  req.url = 'https://' + req.url;
  const targetHost = url.parse(req.url).host; // extract target host

  const onError = () => {
    // targetHost is last request, normal error
    if (!sourceHistory[source] || sourceHistory[source].host === targetHost) {
      if (DEBUG_LEVEL & DEBUG.ERROR)
        console.error(`${source}!>${req.method} ${req.url}`);
      res.writeHead(502, `cannot access ${req.url}`, {"Content-Type": "text/plain"});
      res.end();
    } else { // else try to redirect to known host
      if (DEBUG_LEVEL & DEBUG.REDIRECT)
        console.log(req.url + ' => ' + sourceHistory[source].host + '/' + reqUrl.path);
      req.url = sourceHistory[source].host + '/' + reqUrl.path;
      proxyRequest(req, res);
    }
  };

  try {
    if (req.headers['upgrade-insecure-requests'] || !sourceHistory[source]) {
      sourceHistory[source] = {
        host: targetHost,
        time: time
      };
      if (DEBUG_LEVEL & (DEBUG.REQUEST | DEBUG.INIT_REQ))
        console.log(`${source}>>${req.method} ${req.url}`);
    } else if (DEBUG_LEVEL & DEBUG.REQUEST)
      console.log(`${source}>${req.method} ${req.url}`);
    // change request headers to avoid issues
    req.headers['host'] = targetHost;
    REMOVE_REQ_HEADERS.forEach(key => delete req.headers[key]);
    // pipe original request to a new one
    req.pipe(request(req.url)
      .on('error', onError)
      .on('response', r => {
        let contentType = (r.headers['content-type'] || 'unknown').split(';')[0];
        if (DEBUG_LEVEL & DEBUG.RESPONSE)
          console.log(`${source}<${r.statusCode} (${contentType}) ${req.url}`);
        if (!r.headers['content-type']) // unknown content, just send it as-is
          return r.pipe(res);
        // remove troublesome headers
        REMOVE_RESP_HEADERS.forEach(key => delete r.headers[key]);
        // write correct response head
        res.writeHead(res.statusCode, r.headers);
        // change data by content-type
        switch (contentType) {
          case 'text/html':
            r.pipe(scriptTransform(targetHost))
              .pipe(htmlTransform(req.url))
              .pipe(cssTransform(req.url))
              .pipe(basicTransform(req.url))
              .pipe(res);
            break;
          case 'text/css':
            r.pipe(cssTransform(req.url))
              .pipe(basicTransform(req.url))
              .pipe(res);
            break;
          case 'text/javascript':
          case 'application/javascript':
            // TODO breaking some JS, need to refine
            r.pipe(scriptTransform(targetHost))
              .pipe(basicTransform(req.url))
              .pipe(res);
            break;
          case 'application/json':
          case 'text/xml':
          case 'application/xml':
          case 'application/xhtml+xml':
            r.pipe(basicTransform(req.url))
              .pipe(res);
            break;
          default:
            // simply send data without change
            r.pipe(res);
            break;
        }
      }));
  } catch {
    onError();
  }
};

console.log('Creating server...');
const server = http.createServer((req, res) => {
  if (req.url === '/') { // on root path, send index
    res.writeHead(200, {"Content-Type": "text/html"});
    res.write(html);
    res.end();
  } else if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400' // 1 day
    });
    res.end();
  } else { // redirect to URL
    req.url = req.url.substr(1); // remove initial / in path
    const reqUrl = url.parse(req.url);
    if (reqUrl.protocol != null) {
      res.writeHead(301, {"Location": reqUrl.slashes ? '/' + reqUrl.host + reqUrl.path : reqUrl.path});
      res.end();
    } else if (/^(\w+\.)+\w+$/g.test(req.url)) {
      res.writeHead(301, {"Location": '/' + req.url + '/'});
      res.end();
    } else {
      proxyRequest(req, res);
    }
  }
});

console.log(`yxorp started at ${proxy}`);
server.listen(port);