'use strict'

const http = require('http')
const https = require('https')
const dns = require('dns')

const warnings = require('./warnings')
const { kState, kOptions, kServerBindings } = require('./symbols')
const {
  FST_ERR_HTTP2_INVALID_VERSION,
  FST_ERR_REOPENED_CLOSE_SERVER,
  FST_ERR_REOPENED_SERVER
} = require('./errors')

module.exports.createServer = createServer
module.exports.compileValidateHTTPVersion = compileValidateHTTPVersion

function defaultResolveServerListeningText (address) {
  return `Server listening at ${address}`
}

/**
 * 返回对象：
 * {
 *  server: Http服务实例
 *  listen: 函数用于启动服务器并监听传入的连接。
 * }
 */
function createServer (options, httpHandler) {
  const server = getServerInstance(options, httpHandler)

  return { server, listen }

  // `this` is the Fastify object
  function listen (listenOptions, ...args) {
    // 获取 args 数组的最后一个元素，并使用 pop() 方法将其从数组args中删除。
    let cb = args.slice(-1).pop()
    // When the variadic signature deprecation is complete, the function
    // declaration should become:
    //   function listen (listenOptions = { port: 0, host: 'localhost' }, cb = undefined)
    // Upon doing so, the `normalizeListenArgs` function is no longer needed,
    // and all of this preamble to feed it correctly also no longer needed.
    // 获取listenOptions的类型信息。
    const firstArgType = Object.prototype.toString.call(arguments[0])
    if (arguments.length === 0) {
      // 如果没有传入参数，则使用默认参数 { port: 0, host: 'localhost' } 并将其规范化。
      listenOptions = normalizeListenArgs([])
    } else if (arguments.length > 0 && (firstArgType !== '[object Object]' && firstArgType !== '[object Function]')) {
      // 如果传入的参数中第一个参数不是对象或函数，则发出警告并将所有参数规范化。
      warnings.emit('FSTDEP011')
      listenOptions = normalizeListenArgs(Array.from(arguments))
      cb = listenOptions.cb
    } else if (args.length > 1) {
      // `.listen(obj, a, ..., n, callback )`
      // 发出一个警告，表示这种使用方式已经被弃用。
      warnings.emit('FSTDEP011')
      // Deal with `.listen(port, host, backlog, [cb])`
      // 根据 listenOptions.path 属性是否存在来判断参数中是否指定了管道路径。
      // 如果存在，则创建一个包含 listenOptions.path 属性的数组 hostPath，否则创建一个包含端口号和主机名的数组 hostPath。
      const hostPath = listenOptions.path ? [listenOptions.path] : [listenOptions.port ?? 0, listenOptions.host ?? 'localhost']
      Object.assign(listenOptions, normalizeListenArgs([...hostPath, ...args]))
    } else {
      // 如果函数调用参数的长度为 1，且第一个参数是对象或函数类型，则将 cb 赋值给 listenOptions.cb 属性。
      listenOptions.cb = cb
    }

    // If we have a path specified, don't default host to 'localhost' so we don't end up listening
    // on both path and host
    // See https://github.com/fastify/fastify/issues/4007
    let host
    // 根据传入的 listenOptions 参数中是否包含 path 属性，决定是否将 host 属性设置为 'localhost'。
    if (listenOptions.path == null) {
      host = listenOptions.host ?? 'localhost'
    } else {
      host = listenOptions.host
    }
    // 如果 host 属性为 'localhost'，则将回调函数包装在一个函数中，在服务器启动时调用多个绑定函数并调用回调函数。
    if (Object.prototype.hasOwnProperty.call(listenOptions, 'host') === false) {
      listenOptions.host = host
    }

    if (host === 'localhost') {
      // 如果 host 属性为 'localhost'，设置下面函数为回调函数。
      listenOptions.cb = (err, address) => {
        if (err) {
          // the server did not start
          cb(err, address)
          return
        }
        // 在服务器启动时调用多个绑定函数并调用回调函数。
        multipleBindings.call(this, server, httpHandler, options, listenOptions, () => {
          // 标识服务器启动成功。
          this[kState].listening = true
          cb(null, address)
        })
      }
    }

    // https://github.com/nodejs/node/issues/9390
    // If listening to 'localhost', listen to both 127.0.0.1 or ::1 if they are available.
    // If listening to 127.0.0.1, only listen to 127.0.0.1.
    // If listening to ::1, only listen to ::1.

    if (cb === undefined) {
      // 通过调用 listenPromise 函数开始监听服务器端口。
      const listening = listenPromise.call(this, server, listenOptions)
      /* istanbul ignore else */
      if (host === 'localhost') {
        // 如果传入的主机地址为 'localhost'，则返回一个 Promise 对象，该 Promise 对象在监听成功后会调用 multipleBindings 函数处理多个绑定的情况，并返回服务器端口的地址。
        return listening.then(address => {
          return new Promise((resolve, reject) => {
            multipleBindings.call(this, server, httpHandler, options, listenOptions, () => {
              this[kState].listening = true
              resolve(address)
            })
          })
        })
      }
      // 如果主机地址不是 'localhost'，则直接返回 listenPromise 函数返回的 Promise 对象。
      return listening
    }
    // 准备好，开始监听端口。
    this.ready(listenCallback.call(this, server, listenOptions))
  }
}

// 用于启动额外的服务器。
function multipleBindings (mainServer, httpHandler, serverOpts, listenOptions, onListen) {
  // the main server is started, we need to start the secondary servers
  // 将 this[kState].listening 设置为 false，表示服务器尚未开始监听。
  this[kState].listening = false

  // let's check if we need to bind additional addresses
  // 使用 dns.lookup 方法查询指定主机名的所有 IP 地址。
  dns.lookup(listenOptions.host, { all: true }, (dnsErr, addresses) => {
    if (dnsErr) {
      // not blocking the main server listening
      // this.log.warn('dns.lookup error:', dnsErr)
      // 标识服务启动成功
      onListen()
      return
    }

    let binding = 0
    let binded = 0
    const primaryAddress = mainServer.address()
    // 对于每个不同的 IP 地址，都会启动一个新的辅助服务器，并将其绑定到主服务器。
    for (const adr of addresses) {
      if (adr.address !== primaryAddress.address) {
        binding++
        // 对于每个辅助服务器，该函数会将其地址、端口号和回调函数等信息存储在 secondaryOpts 对象中。
        const secondaryOpts = Object.assign({}, listenOptions, {
          host: adr.address,
          port: primaryAddress.port,
          cb: (_ignoreErr) => {
            binded++

            if (!_ignoreErr) {
              // 存放辅助服务器
              this[kServerBindings].push(secondaryServer)
            }

            if (binded === binding) {
              // regardless of the error, we are done
              // 标识服务启动成功
              onListen()
            }
          }
        })
        // 使用 getServerInstance 方法创建一个新的辅助服务器实例。
        const secondaryServer = getServerInstance(serverOpts, httpHandler)
        const closeSecondary = () => { secondaryServer.close(() => {}) }
        // 将辅助服务器的 upgrade 事件和主服务器的 close、error 和 unref 事件绑定在一起。
        secondaryServer.on('upgrade', mainServer.emit.bind(mainServer, 'upgrade'))
        mainServer.on('unref', closeSecondary)
        mainServer.on('close', closeSecondary)
        mainServer.on('error', closeSecondary)
        // 处理辅助服务器监听事件。
        listenCallback.call(this, secondaryServer, secondaryOpts)()
      }
    }

    // no extra bindings are necessary
    // 没有额外的辅助服务器，标识服务启动成功，并返回
    if (binding === 0) {
      onListen()
      return
    }

    // in test files we are using unref so we need to propagate the unref event
    // to the secondary servers. It is valid only when the user is
    // listening on localhost
    // 在测试文件中，为了将 unref 事件传播到辅助服务器，该函数重写了主服务器的 unref 方法。
    // 当主服务器上的 unref 方法被调用时，它会调用原始的 unref 方法，并触发一个 unref 事件。
    const originUnref = mainServer.unref
    /* istanbul ignore next */
    mainServer.unref = function () {
      originUnref.call(mainServer)
      mainServer.emit('unref')
    }
  })
}
// 处理服务器监听事件。
function listenCallback (server, listenOptions) {
  // 在监听事件发生错误时被调用。
  const wrap = (err) => {
    // 移除 error 事件的监听器，并根据错误类型调用回调函数。
    server.removeListener('error', wrap)
    if (!err) {
      // 获取服务器的地址信息。
      const address = logServerAddress.call(this, server, listenOptions.listenTextResolver || defaultResolveServerListeningText)
      listenOptions.cb(null, address)
    } else {
      this[kState].listening = false
      listenOptions.cb(err, null)
    }
  }

  return (err) => {
    // 判断传入的错误 err 是否为空，如果不为空则直接调用监听选项中的回调函数 cb 并返回。
    if (err != null) return listenOptions.cb(err)
    // 判断服务器当前的状态是否为正在监听并且正在关闭中。
    if (this[kState].listening && this[kState].closing) {
      // 放回一个Fastify has already been closed and cannot be reopened
      return listenOptions.cb(new FST_ERR_REOPENED_CLOSE_SERVER(), null)
    } else if (this[kState].listening) {
      // 如果服务器正在监听但没有处于关闭状态。
      // 返回一个Fastify is already listening。
      return listenOptions.cb(new FST_ERR_REOPENED_SERVER(), null)
    }
    // 如果服务器状态为未在监听中，则将 wrap 函数添加为 error 事件的监听器，并调用 server.listen 方法开始监听，并将服务器状态 this[kState].listening 设置为 true。
    server.once('error', wrap)
    server.listen(listenOptions, wrap)

    this[kState].listening = true
  }
}

// 通过 Promise 的方式异步监听服务器的端口。
function listenPromise (server, listenOptions) {
  // 
  if (this[kState].listening && this[kState].closing) {
    // 服务器的状态正在监听并且正在关闭中。
    // Fastify has already been closed and cannot be reopened.
    return Promise.reject(new FST_ERR_REOPENED_CLOSE_SERVER())
  } else if (this[kState].listening) {
    // 服务器的状态已经在监听中。
    // Fastify is already listening.
    return Promise.reject(new FST_ERR_REOPENED_SERVER())
  }

  return this.ready().then(() => {
    let errEventHandler
    // 创建一个 Promise 对象 errEvent，用于处理服务器监听事件发生错误的情况。
    // 添加 error 事件的监听器，并在监听事件发生错误时标记服务器状态为未在监听中，并将 Promise 对象状态设置为被拒绝。
    const errEvent = new Promise((resolve, reject) => {
      errEventHandler = (err) => {
        this[kState].listening = false
        reject(err)
      }
      server.once('error', errEventHandler)
    })
    // 创建一个 Promise 对象 listen，用于开始监听服务器端口。
    // 同时添加回调函数并在回调函数中移除 error 事件的监听器，并将 Promise 对象状态设置为已监听，并返回服务器端口的地址。
    const listen = new Promise((resolve, reject) => {
      server.listen(listenOptions, () => {
        server.removeListener('error', errEventHandler)
        resolve(logServerAddress.call(this, server, listenOptions.listenTextResolver || defaultResolveServerListeningText))
      })
      // we set it afterwards because listen can throw
      this[kState].listening = true
    })

    return Promise.race([
      errEvent, // e.g invalid port range error is always emitted before the server listening
      listen
    ])
  })
}

/**
 * Creates a function that, based upon initial configuration, will
 * verify that every incoming request conforms to allowed
 * HTTP versions for the Fastify instance, e.g. a Fastify HTTP/1.1
 * server will not serve HTTP/2 requests upon the result of the
 * verification function.
 *
 * @param {object} options fastify option
 * @param {function} [options.serverFactory] If present, the
 * validator function will skip all checks.
 * @param {boolean} [options.http2 = false] If true, the validator
 * function will allow HTTP/2 requests.
 * @param {object} [options.https = null] https server options
 * @param {boolean} [options.https.allowHTTP1] If true and use
 * with options.http2 the validator function will allow HTTP/1
 * request to http2 server.
 *
 * @returns {function} HTTP version validator function.
 */
function compileValidateHTTPVersion (options) {
  let bypass = false
  // key-value map to store valid http version
  const map = new Map()
  if (options.serverFactory) {
    // When serverFactory is passed, we cannot identify how to check http version reliably
    // So, we should skip the http version check
    bypass = true
  }
  if (options.http2) {
    // HTTP2 must serve HTTP/2.0
    map.set('2.0', true)
    if (options.https && options.https.allowHTTP1 === true) {
      // HTTP2 with HTTPS.allowHTTP1 allow fallback to HTTP/1.1 and HTTP/1.0
      map.set('1.1', true)
      map.set('1.0', true)
    }
  } else {
    // HTTP must server HTTP/1.1 and HTTP/1.0
    map.set('1.1', true)
    map.set('1.0', true)
  }
  // The compiled function here placed in one of the hottest path inside fastify
  // the implementation here must be as performant as possible
  return function validateHTTPVersion (httpVersion) {
    // `bypass` skip the check when custom server factory provided
    // `httpVersion in obj` check for the valid http version we should support
    return bypass || map.has(httpVersion)
  }
}

function getServerInstance (options, httpHandler) {
  let server = null
  // 如果 options 中指定了一个 serverFactory 属性，则使用该函数创建服务器实例。
  if (options.serverFactory) {
    server = options.serverFactory(httpHandler, options)
  } else if (options.http2) {
    // 如果 options.http2 为真，则创建 HTTP/2 服务器实例。
    if (options.https) {
      // 如果指定了 options.https，则创建一个安全的 HTTP/2 服务器实例。
      server = http2().createSecureServer(options.https, httpHandler)
    } else {
      // 创建一个普通的 HTTP/2 服务器实例。
      server = http2().createServer(httpHandler)
    }
    server.on('session', sessionTimeout(options.http2SessionTimeout))
  } else {
    // 如果指定了 options.https，则创建一个安全的 HTTP/1 服务器实例。
    if (options.https) {
      server = https.createServer(options.https, httpHandler)
    } else {
      // 创建一个普通的 HTTP/1 服务器实例。
      server = http.createServer(options.http, httpHandler)
    }
    // 将 options.keepAliveTimeout 和 options.requestTimeout 设置为服务器实例的属性。
    server.keepAliveTimeout = options.keepAliveTimeout
    server.requestTimeout = options.requestTimeout
    // we treat zero as null
    // and null is the default setting from nodejs
    // so we do not pass the option to server
    // options.maxRequestsPerSocket 大于零，则将其设置为服务器实例的 maxRequestsPerSocket 属性。
    if (options.maxRequestsPerSocket > 0) {
      server.maxRequestsPerSocket = options.maxRequestsPerSocket
    }
  }

  if (!options.serverFactory) {
    // 如果 options.serverFactory 不存在，则设置服务器实例的超时时间为 options.connectionTimeout。
    server.setTimeout(options.connectionTimeout)
  }
  return server
}

function normalizeListenArgs (args) {
  if (args.length === 0) {
    return { port: 0, host: 'localhost' }
  }

  // 将最后一个参数赋值给变量 cb，如果最后一个参数是一个函数，则将其从参数列表中删除。
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
  // 创建一个包含 cb 属性的 options 对象。
  const options = { cb }

  const firstArg = args[0]
  const argsLength = args.length
  const lastArg = args[argsLength - 1]
  // 如果第一个参数是一个字符串而不是数字，则假定它是一个管道路径，并将其赋值给 options.path 属性。
  if (typeof firstArg === 'string' && isNaN(firstArg)) {
    /* Deal with listen (pipe[, backlog]) */
    options.path = firstArg
    // 如果 args 数组长度大于 1，则将最后一个元素赋值给 options.backlog 属性，否则将 undefined 赋值给 options.backlog 属性。
    options.backlog = argsLength > 1 ? lastArg : undefined
  } else {
    /* Deal with listen ([port[, host[, backlog]]]) */
    // 如果第一个参数是数字类型，则假定它是端口号。
    // 如果第一个参数是整数，则将其作为 options.port 属性的值，否则将其传递给 normalizePort 函数进行规范化处理。
    options.port = argsLength >= 1 && Number.isInteger(firstArg) ? firstArg : normalizePort(firstArg)
    // This will listen to what localhost is.
    // It can be 127.0.0.1 or ::1, depending on the operating system.
    // Fixes https://github.com/fastify/fastify/issues/1022.
    // 如果 args 数组长度大于等于 2，则将第二个元素作为 options.host 属性的值，否则将 'localhost' 作为默认值。
    options.host = argsLength >= 2 && args[1] ? args[1] : 'localhost'
    // 如果 args 数组长度大于等于 3，则将第三个元素赋值给 options.backlog 属性，否则将 undefined 赋值给 options.backlog 属性。
    options.backlog = argsLength >= 3 ? args[2] : undefined
  }

  return options
}

function normalizePort (firstArg) {
  const port = Number(firstArg)
  return port >= 0 && !Number.isNaN(port) && Number.isInteger(port) ? port : 0
}
// 记录服务器的地址信息。
function logServerAddress (server, listenTextResolver) {
  // 获取服务器的地址信息。
  let address = server.address()
  // 判断地址是否为 Unix 套接字。
  const isUnixSocket = typeof address === 'string'
  /* istanbul ignore next */
  if (!isUnixSocket) {
    // 将地址和端口号组合成 IPv4 或 IPv6 地址格式。
    if (address.address.indexOf(':') === -1) {
      address = address.address + ':' + address.port
    } else {
      address = '[' + address.address + ']:' + address.port
    }
  }
  /* istanbul ignore next */
  // 根据是否为 Unix 套接字，将地址转换为 HTTP 或 HTTPS URL 格式。
  address = (isUnixSocket ? '' : ('http' + (this[kOptions].https ? 's' : '') + '://')) + address
  // 使用指定的地址解析器（listenTextResolver）获取服务器监听的文本信息，并将其记录在服务器日志中。
  const serverListeningText = listenTextResolver(address)
  this.log.info(serverListeningText)
  return address
}

function http2 () {
  try {
    return require('http2')
  } catch (err) {
    throw new FST_ERR_HTTP2_INVALID_VERSION()
  }
}

function sessionTimeout (timeout) {
  return function (session) {
    session.setTimeout(timeout, close)
  }
}

function close () {
  this.close()
}
