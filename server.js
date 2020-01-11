const fs = require('fs');
const http = require('http');
const request = require('request');
const url = require('url');
const {Transform} = require('stream');

const DEBUG = false;

console.log('Loading home page...');
const html = fs.readFileSync('index.html');

console.log('Creating server...');
const port = process.argv[2] || 5050;
let proxy = process.argv[3] || `http://localhost:${port}`;

if(!proxy.endsWith('/'))
  proxy += '/';

const rewriteUrl = (prefix, u, suffix, targetUrl) => {
  let protocol = url.parse(targetUrl).protocol;
  let targetOrigin = url.parse(targetUrl).origin;
  if (/^\w+:\/\//gi.test(u)) {
    return prefix + proxy + u + suffix;
  } else if (u.startsWith('//')) {
    return prefix + proxy + protocol + u + suffix;
  } else if (u.startsWith('/')) {
    return prefix + proxy + targetOrigin + u + suffix;
  } else {
    return prefix + u + suffix;
  }
};

const changeByRegex = (input, regex, transform) => {
  const matches = input.matchAll(regex);
  let output = '';
  let i = 0;
  for (const match of matches) {
    output += input.substr(i, match.index - i) + transform(match);
    i = match.index + match[0].length;
  }
  output += input.substr(i);
  return output;
};

const htmlTransform = (targetUrl) => {
  const stream = new Transform();
  let body = '';
  stream._transform = (chunk, enc, next) => {
    if (chunk) {
      body += chunk;
      next(null, null);
    }
  };
  stream._flush = (next => {
    let output = changeByRegex(body, /(href|src|url)=["']([^"']+)["']/gm,
      m => rewriteUrl(`${m[1]}="`, m[2], '"', targetUrl));
    let output2 = changeByRegex(output, /url\(([^)]*)\)/gm,
      m => rewriteUrl('url(', m[1], ')', targetUrl));
    next(null, output2);
  });
  return stream;
};

const cssTransform = (targetUrl) => {
  const stream = new Transform();
  let body = '';
  stream._transform = (chunk, enc, next) => {
    if (chunk) {
      body += chunk;
      next(null, null);
    }
  };
  stream._flush = (next => {
    let output = changeByRegex(body, /url\(([^)]*)\)/gm,
      m => rewriteUrl('url(', m[1], ')', targetUrl));
    next(null, output);
  });
  return stream;
};

const basicTransform = (targetUrl) => {
  const stream = new Transform();
  let body = '';
  stream._transform = (chunk, enc, next) => {
    if (chunk) {
      body += chunk;
      next(null, null);
    }
  };
  stream._flush = (next => {
    let output = changeByRegex(body, /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:/~+#-]*[\w@?^=%&/~+#-])?/gm,
      m => rewriteUrl('', m[0], '', targetUrl));
    next(null, output);
  });
  return stream;
};


const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {"Content-Type": "text/html"});
    res.write(html);
    res.end();
  } else if (req.url === '/favicon.ico') {
    res.writeHead(404, 'not found', {"Content-Type": "text/plain"});
    res.end();
  } else {
    if (req.url.substr(0, 1) === '/')
      req.url = req.url.substr(1);
    if (!/^\w+:\/\//gi.test(req.url))
      req.url = 'https://' + req.url;
    if(DEBUG)
      console.log(`>${req.url}`);
    request({
      url: req.url
    }).on('error', e => {
      console.error(`!${req.url}`);
      res.writeHead(500, 'internal error', {"Content-Type": "text/plain"});
      res.end();
    }).on('response', r => {
      if (!r.headers['content-type'])
        return r.pipe(res);
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
          r.pipe(basicTransform(req.url)).pipe(res);
          break;
        default:
          r.pipe(res);
          break;
      }
    });
  }
});

console.log(`yxorp started at ${proxy}`);
server.listen(port);