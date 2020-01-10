# yxorp
A simple proxy for totally legal purposes

Proxy your requests and rewrite pages/styles to follow the same rule

### To use :

```
node server.js [port] [proxy-origin]
```

proxy-origin should be as "http(s)://your.host"

It will be placed before every link so be sure to change it when needed

### To install :

```
git clone https://github.com/Klemek/yxorp
cd yxorp
npm install
npm install -g nodemon
nodemon ./server.js 3000
# started on localhost:3000
# go to http://localhost:3000/stackoverflow.com (it should works there)
```

### Disclaimer : reasons it might break

1. (on localhost) websites that doesn't like "being" on another port
2. websites that doesn't like not being the host
3. dynamic URLs created in scripts
