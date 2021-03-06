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

const DEBUG_LEVEL = DEBUG.REQUEST | DEBUG.RESPONSE | DEBUG.REDIRECT;

const PROTOCOLS = {
  'acap:': 674,
  'afp:': 548,
  'dict:': 2628,
  'dns:': 53,
  'ftp:': 21,
  'git:': 9418,
  'gopher:': 70,
  'http:': 80,
  'https:': 443,
  'imap:': 143,
  'ipp:': 631,
  'ipps:': 631,
  'irc:': 194,
  'ircs:': 6697,
  'ldap:': 389,
  'ldaps:': 636,
  'mms:': 1755,
  'msrp:': 2855,
  'mtqp:': 1038,
  'nfs:': 111,
  'nntp:': 119,
  'nntps:': 563,
  'pop:': 110,
  'prospero:': 1525,
  'redis:': 6379,
  'rsync:': 873,
  'rtsp:': 554,
  'rtsps:': 322,
  'rtspu:': 5005,
  'sftp:': 22,
  'smb:': 445,
  'snmp:': 161,
  'ssh:': 22,
  'svn:': 3690,
  'telnet:': 23,
  'ventrilo:': 3784,
  'vnc:': 5900,
  'wais:': 210,
  'ws:': 80,
  'wss': 443
};

const REVERSE_PROTOCOLS = {
  674: 'acap:',
  548: 'afp:',
  2628: 'dict:',
  53: 'dns:',
  21: 'ftp:',
  9418: 'git:',
  70: 'gopher:',
  80: 'http:',
  443: 'https:',
  143: 'imap:',
  631: 'ipp:',
  194: 'irc:',
  6697: 'ircs:',
  389: 'ldap:',
  636: 'ldaps:',
  1755: 'mms:',
  2855: 'msrp:',
  1038: 'mtqp:',
  111: 'nfs:',
  119: 'nntp:',
  563: 'nntps:',
  110: 'pop:',
  1525: 'prospero:',
  6379: 'redis:',
  873: 'rsync:',
  554: 'rtsp:',
  322: 'rtsps:',
  5005: 'rtspu:',
  22: 'sftp:',
  445: 'smb:',
  161: 'snmp:',
  3690: 'svn:',
  23: 'telnet:',
  3784: 'ventrilo:',
  5900: 'vnc:',
  210: 'wais:'
};

const REMOVE_REQ_HEADERS = [
  'accept-encoding',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user'];
const REMOVE_RESP_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-method',
  'content-security-policy',
  'content-length'
];
const HISTORY_TIMEOUT = 6e5; // 10 minutes
// popular top level domains
// http://www.seobythesea.com/2006/01/googles-most-popular-and-least-popular-top-level-domains/
const TOP_LEVEL_DOMAINS = ['com', 'org', 'edu', 'gov', 'uk', 'net',
                            'ca', 'de', 'jp', 'fr', 'au', 'us', 'ru',
                            'ch', 'it', 'nl', 'se', 'no', 'es', 'mil'];

console.log('DEBUG LEVELS :');
Object.keys(DEBUG).forEach(key => {
  if (DEBUG_LEVEL & DEBUG[key])
    console.log(' - ' + key);
});

const port = process.argv[2] || 5050;
const proxyPart = process.argv[3] || `http://localhost:${port}`;
const proxy = url.parse(proxyPart);
const index = process.argv[4] || 'index.html';
const sourceHistory = {};

console.log('Loading home page...');
const html = fs.readFileSync(index);


/**
 * Extract port and hostname to redirect correctly
 * @param parsedUrl
 * @returns {string}
 */
const writeHost = (parsedUrl) => {
  if (parsedUrl.port)
    return '/' + parsedUrl.port + '/' + parsedUrl.hostname;
  else if (parsedUrl.protocol !== proxy.protocol)
    return '/' + PROTOCOLS[parsedUrl.protocol] + '/' + parsedUrl.hostname;
  else
    return '/' + parsedUrl.hostname;
};

/**
 * Rewrite URL to add proxy before it
 * @param {string} prefix - to add before URL
 * @param {string} u - the url to rewrite
 * @param {string} suffix - to add after URL
 * @param {string} targetUrl - URL of the current page
 * @returns {string}
 */
const rewriteUrl = (prefix, u, suffix, targetUrl) => {
  if (u.includes(proxy.hostname)) //already treated
    return prefix + u + suffix;
  let parsedTarget = url.parse(targetUrl);
  let parsedMatch = url.parse(u);
  if (parsedMatch.protocol && parsedMatch.slashes) { // full URL with protocol (https://google.com/favicon.ico)
    if(parsedMatch.path === '/' && !u.endsWith('/')) // special case where it's just https://google.com
      parsedMatch.path = '';
    return prefix + proxyPart + writeHost(parsedMatch) + parsedMatch.path + suffix; // simply add proxy
  } else if (u.startsWith('//')) { // full URL without protocol (//google.com/favicon.ico)
    parsedMatch = url.parse('http:' + u);
    return prefix + proxy.protocol + '//' + proxy.host + writeHost(parsedMatch) + suffix; // add proxy
  } else if (u.startsWith('/')) { // URL with root path (/favicon.ico)
    return prefix + parsedTarget.protocol + '//' + proxy.host + writeHost(parsedTarget) + u + suffix; // add proxy and origin (https://google.com)
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
 * TODO jsdoc
 */
const injectProxyScript = (targetUrl) => {
  let parsedTarget = url.parse(targetUrl);
  return `
(function() {
	var rewriteUrl = (u) => {
	  if (u.includes("${proxy.hostname}"))
		  return u;
	  var u2 = new URL(u);
	  if (u2.protocol) {
		  return "${proxyPart}" + u2.hostname + u2.path;
	  } else if (u.startsWith("//")) {
		  u2 = new URL('http:' + u);
		  return "${proxy.protocol}//${proxy.host}" + u2.hostname;
	  } else if (u.startsWith("/")) {
		  return "${parsedTarget.protocol}${proxy.host}${writeHost(parsedTarget)}" + u;
	  } else {
		  return u;
	  }
	};
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
      arguments[1] = rewriteUrl(arguments[1]);
      origOpen.apply(this, arguments);
  };
})();`
}

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
 * Create a special Stream Transform that count data length
 * @param res
 * @param statusCode
 * @param headers
 * @returns {module:stream.internal.Transform}
 */
const writeHeadTransform = (res, statusCode, headers) => {
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
    if(!input || !input.length)
      headers['content-length'] = '0';
    /*else
      headers['content-length'] = input.length.toString();*/
    res.writeHead(statusCode, headers);
    next(null, input);
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
  // inject custom js in head
  /*let output2 = changeByRegex(output1, /<\/head>/gm,
    m => '<script>' + injectProxyScript(targetUrl) + '</script></head>', DEBUG.HTML_MATCH);*/
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
 * TODO jsdoc
 */
const scriptTransform = (targetUrl, isScript) => contentTransform(input => {
  // found domains like (//something.com/)
  let output1 = changeByRegex(input, /\/\/((\w+\.)+\w+)\//gm,
    m => '//' + proxy.host + m[0].substr(1), DEBUG.SCRIPT_MATCH);
  // found escaped domains like (\/\/something.com\/)
  let output2 = changeByRegex(output1, /\\\/\\\/((\w+\.)+\w+)\\\//gm,
    m => '\\/\\/' + proxy.host + m[0].substr(2), DEBUG.SCRIPT_MATCH);
  // found domain check
  // TODO optimize
  let output3 = changeByRegex(output2, /(["'])(?:\w+\.){1,}(\w+)(['"] ?==)/gm,
    m => TOP_LEVEL_DOMAINS.includes(m[2]) ? m[1] + proxy.hostname + m[3] : m[0], DEBUG.SCRIPT_MATCH);
  let output4 = changeByRegex(output3, /(== ?["'])(?:\w+\.){1,}(\w+)(['"])/gm,
    m => TOP_LEVEL_DOMAINS.includes(m[2]) ? m[1] + proxy.hostname + m[3] : m[0], DEBUG.SCRIPT_MATCH);
  // inject proxy script before script
  // TODO not working
  /*if(isScript)
    output4 = injectProxyScript(targetUrl) + output4;*/
  // found source map
  return changeByRegex(output4, /\/\/# sourceMappingURL=[^\n]+/gm,
    m => '', DEBUG.NONE);
});

/**
 * Stream Transform to rewrite any URLs found
 * @param {string} targetUrl - current page URL
 * @returns {module:stream.internal.Transform}
 */
const basicTransform = (targetUrl) =>
  contentTransform(input => {
    // full URLs
    let output1 = changeByRegex(input, /[a-z]{2,}:\/\/([\w_-]+((\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])?/gm,
      m => rewriteUrl('', m[0], '', targetUrl), DEBUG.BASIC_MATCH);
    // full escaped URLs
    return changeByRegex(output1, /[a-z]{2,}:\\\/\\\/([\w_-]+((\.[\w_-]+)+))(([\w.,@?^=%&:~+#-]|\\\/)*([\w@?^=%&~+#-]|\\\/))?/gm,
      m => rewriteUrl('', m[0].replace(/\\\//g, '/'), '', targetUrl).replace(/\//g, '\\/'), DEBUG.BASIC_MATCH);
  });

/**
 * Core of the proxy, will send the request and compute the result
 * @param req
 * @param res
 * @param {number} reqPort
 */
const proxyRequest = (req, res, reqPort) => {
  const source = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const time = new Date().getTime();
  // clear history if too old
  if (sourceHistory[source] && time - sourceHistory[source].time > HISTORY_TIMEOUT)
    delete sourceHistory[source];

  let reqUrl = url.parse(req.url); // keep requested URL
  const originalPath = reqUrl.path; // when redirecting known host

  const reqHost = req.headers['host'];
  if (sourceHistory[source] && reqHost && reqHost.endsWith(proxy.host) && reqHost.length > proxy.host.length) {
    // something is before the host
    const subHost = reqHost.substr(0, reqHost.length - proxy.host.length);
    if (DEBUG_LEVEL & DEBUG.REDIRECT)
      console.log(req.url + ' => ' + subHost + sourceHistory[source].host + '/' + reqUrl.path);
    req.url = subHost + sourceHistory[source].host + '/' + reqUrl.path;
  }

  req.url = (REVERSE_PROTOCOLS[reqPort] || 'https:') + '//' + req.url;
  reqUrl = url.parse(req.url);

  const onError = () => {
    // target host is last request, normal error
    if (!sourceHistory[source] || sourceHistory[source].host === reqUrl.host) {
      if (DEBUG_LEVEL & DEBUG.ERROR)
        console.error(`${source}!>${req.method} ${req.url}`);
      res.writeHead(502, `cannot access ${req.url}`, {"Content-Type": "text/plain"});
      res.end();
    } else { // else try to redirect to known host
      if (DEBUG_LEVEL & DEBUG.REDIRECT)
        console.log(req.url + ' => ' + sourceHistory[source].host + '/' + originalPath);
      req.url = sourceHistory[source].host + '/' + originalPath;
      proxyRequest(req, res);
    }
  };

  try {
    if (req.headers['upgrade-insecure-requests'] || !sourceHistory[source]) {
      sourceHistory[source] = {
        host: reqUrl.host,
        time: time
      };
      if (DEBUG_LEVEL & (DEBUG.REQUEST | DEBUG.INIT_REQ))
        console.log(`${source}>>${req.method} ${req.url}`);
    } else if (DEBUG_LEVEL & DEBUG.REQUEST)
      console.log(`${source}>${req.method} ${req.url}`);
    // change request headers to avoid issues
    req.headers['host'] = reqUrl.host;
    REMOVE_REQ_HEADERS.forEach(key => delete req.headers[key]);
    // pipe original request to a new one
    req.pipe(request(req.url)
      .on('error', onError)
      .on('response', r => {
        let contentType = (r.headers['content-type'] || 'unknown').split(';')[0];
	if(contentType.includes(','))
	  contentType = contentType.split(',')[0];
        if (DEBUG_LEVEL & DEBUG.RESPONSE)
          console.log(`${source}<${r.statusCode} (${contentType}) ${req.url}`);
        // remove troublesome headers
        const tmpContentLength = r.headers['content-length'];
        REMOVE_RESP_HEADERS.forEach(key => delete r.headers[key]);
        // change data by content-type
        switch (contentType) {
          case 'text/html':
	        case 'application/xhtml+xml':
            r.pipe(scriptTransform(req.url, false))
              .pipe(htmlTransform(req.url))
              .pipe(cssTransform(req.url))
              .pipe(basicTransform(req.url))
              .pipe(writeHeadTransform(res, r.statusCode, r.headers))
              .pipe(res);
            break;
          case 'text/css':
            r.pipe(cssTransform(req.url))
              .pipe(basicTransform(req.url))
              .pipe(writeHeadTransform(res, r.statusCode, r.headers))
              .pipe(res);
            break;
          case 'text/javascript':
          case 'application/javascript':
            r.pipe(scriptTransform(sourceHistory[source] ? sourceHistory[source].href : req.url, true))
              .pipe(basicTransform(req.url))
              .pipe(writeHeadTransform(res, r.statusCode, r.headers))
              .pipe(res);
            break;
          case 'application/json':
          case 'text/xml':
          case 'application/xml':
          case 'application/rss+xml':
            r.pipe(basicTransform(req.url))
              .pipe(writeHeadTransform(res, r.statusCode, r.headers))
              .pipe(res);
            break;
          default:
            // simply send data without change but restore content-length header
            r.headers['content-length'] = tmpContentLength;
            res.writeHead(r.statusCode, r.headers);
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
    let reqPort;
    if (/^\d+\//gm.test(req.url)) {
      reqPort = req.url.split('/')[0];
      req.url = req.url.substr(reqPort.length + 1);
      reqPort = parseInt(reqPort);
    }
    const reqUrl = url.parse(req.url);
    reqPort = reqPort || reqUrl.port || PROTOCOLS[reqUrl.protocol] || PROTOCOLS[proxy.protocol];
    if (reqUrl.protocol != null) {
      res.writeHead(302, {"Location": reqUrl.slashes ? '/' + reqUrl.host + reqUrl.path : reqUrl.path});
      res.end();
    } else if (/^(\w+\.)+\w+$/g.test(req.url)) {
      res.writeHead(302, {"Location": '/' + req.url + '/'});
      res.end();
    } else {
      proxyRequest(req, res, reqPort);
    }
  }
});

console.log(`yxorp started at ${proxyPart}`);
server.listen(port);
