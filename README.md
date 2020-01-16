# yxorp
A simple proxy for totally legal purposes

Proxy your requests and rewrite pages/styles to follow the same rule

### To use :

```
node server.js [port] [proxy-origin] [index page]
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
3. dynamic HTTP queries created in scripts
4. non-GET method

### How it works

#### Proxying request

When you reach `https://<proxy_host>/google.com/index.html` it will send a request to `https://google.com/index.html` from it's own and retreive you the response.

#### Identifying URLs in response

The response is also modified so that you can receive all resources the same way.

* All files
  * full URLs `https://google.com/image.png`
* CSS and HTML files
  * CSS URLs `url(https://google.com/image.png)`
* JS and HTML files
  * identified domains `//google.com/`
  * identified escaped domains `\/\/google.com\/`
* HTML files
  * common html attributes
    * `src="https://google.com/script.js"`
    * `href='/style.css'`

#### Rewriting URLs in response

All following URLs are rewritten as `https://<proxy_host>/google.com/favicon.ico`:

Type | Input Example
--- | ---
full URL with protocol | `https://google.com/favicon.ico`
full URL without protocol | `//google.com/favicon.ico`
root path URL* | `/favicon.ico`

\* can be rewritten with cache-saved target host (identified by the first request containing the `upgrade-insecure-requests` header)