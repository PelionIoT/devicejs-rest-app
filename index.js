'use strict'

const cookieParser = require('cookie-parser')
const express = require('express')
const http = require('http')
const path = require('path')

module.exports = {
    middleware: global.devicejsRestAppMiddleware,
    utils: global.devicejsRestAppUtils,
    setCloudUtils: function(utils, middleware) {
        this.utils = utils
        this.middleware = middleware
        
        global.devicejsRestAppMiddleware = middleware
        global.devicejsRestAppUtils = utils
    },
    isCloud: function() {
        return !global.hasOwnProperty('dev$') && !global.hasOwnProperty('ddb')
    },
    /**
     *
     * @param appID
     * @param requireAuth*
     * @param setupAppCB a callback to setup the App, prior to web server starting
     * @param appReadyCB* a callback
     * @param opts*
     * @returns {*}
     */
    createApp: function(appID, requireAuth, setupAppCB, appReadyCB, opts) {
        if(arguments.length == 2) {
            setupAppCB = arguments[1]
            requireAuth = false
        }
        
        if(this.isCloud()) {
            let router = express.Router()
            let middleware = this.middleware
            let utils = this.utils
            let authenticate = middleware.authenticate

            router.use(cookieParser())

            if(requireAuth) {
                for(let route of requireAuth) {
                    let method
                    
                    if(route.method == 'get' ||
                        route.method == 'post' ||
                        route.method == 'put' || 
                        route.method == 'delete') {
                        method = router[route.method].bind(router)
                    }
                    else {
                        method = router.use.bind(router)
                    }

                    function attachDevHandles(req, res, next) {
                        let accounts = req.accounts
                        
                        if(accounts.length != 1) {
                            res.status(401).send('Not authorized to access any accounts')
                            
                            return
                        }
                        
                        req.dev$ = utils.getDeviceJSClient(accounts[0])
                        req.ddb = utils.getDeviceDBClient(accounts[0])
                        
                        next()
                    }

                    if(route.path) {
                        method(route.path, authenticate, attachDevHandles)
                    }
                    else {
                        method(authenticate, attachDevHandles)
                    }

                }
            }

            setupAppCB(router)
            
            return {
                router: router,
                appID: appID
            }
        }
        else {
            if(!opts) {
                opts = { }
            }
            
            if(!opts.local_interface) {
                opts.local_interface = '127.0.0.1' // default to running just on loop back, Proxy will handle all else.
            }
            
            var app = express();
            var server = http.Server(app);
            var io, sockio;

            app.use(cookieParser());
            app.use(function(req, res, next) {
                req.dev$ = dev$;
                req.ddb = ddb;
                var orig_redirect = res.redirect;
                // overload redirect so it works
                // http://expressjs.com/api.html#res.redirect
                res.redirect = function() {
                    var n = 0;
                    if(arguments.length>1) {
                        n = 1;
                    }
                    arguments[n] = path.join('/',appID,arguments[n]);
                    orig_redirect.apply(this,arguments);
                }
                next();
            });

            if(!requireAuth) {
                requireAuth = [ ];
            }
            
            setupAppCB(app,express);

            var appServer = dev$.selectByType('AppServer');

            log.debug('look for app server');
            appServer.discover();
            appServer.on('discover', function(resourceID) {
                appServer.stopDiscovering();
                dev$.selectByID(resourceID).call('registerApp', appID).then(function(response) {
                    var response = response[Object.keys(response)[0]];

                    if(response.receivedResponse) {
                        var portNumber = response.response.result;

                        Promise.all(requireAuth.map(function(route) {
                            if(route.path instanceof RegExp) {
                                return dev$.selectByID(resourceID).call('useAuthentication', appID, route.method, route.path.source, true);
                            }
                            else {
                                return dev$.selectByID(resourceID).call('useAuthentication', appID, route.method, route.path, false);
                            }
                        })).then(function() {
                            log.success('App',appID,'http server on',opts.local_interface,':',portNumber);
                            server.listen(portNumber,opts.local_interface);
                            if(opts.need_websocket) {
                                // upgrade server to web sockets, as needed...
                                sockio = require('socket.io');
                                io = sockio(server);
                                if(io)
                                    log.debug('devicejs-rest-app: socket.io listen()ing');
                                if(typeof appReadyCB === 'function') {
                                    appReadyCB(null,{
                                        socketio: io, baseUrl: '/'+appID
                                    });
                                }
                            }
                        }, function(error) {
                            log.error('Error starting app', error);
                            appReadyCB(error);
                        });
                    }
                    else {
                        log.error('Could not register APIProxy with app server');
                    }
                }, function(error) {
                    log.error('Error in devicejs-rest-app setup', error)
                })
            })
        }
    }
}
