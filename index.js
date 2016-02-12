var cookieParser = require('cookie-parser');
var express = require('express');
var http = require('http');
var path = require('path');
var ERRS = require('devicejs-common-error');

var RelayEventsExchange;
var devicejs;
var devicedb;

module.exports = {
    set: function(RlyEventsExchg, devicejsProxy) {
        RelayEventsExchange = RlyEventsExchg;
        devicejs = devicejsProxy.devicejs;
        devicedb = devicejsProxy.devicedb;
    },
    isCloud: function() {
        return !global.hasOwnProperty('dev$') && !global.hasOwnProperty('ddb');
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
            setupAppCB = arguments[1];
            requireAuth = false;
        }
        if(!opts) {
            opts = {};
        }
        if(!opts.local_interface) {
            opts.local_interface = '127.0.0.1'; // default to running just on loop back, Proxy will handle all else.
        }

        if(this.isCloud()) {
            return {
                setup: function(app, utils) {
                    console.log('SETUP CLOUD APP');
                    var authenticate = utils.authenticate;
                    var relayRouter = utils.relayRouter;
                    var accountServiceClient = utils.accountServiceClient;
                    var userServiceClient = utils.userServiceClient;
                    var relayEvents = new RelayEventsExchange.Subscriber(utils.messageBrokerConnectionConfig);
                    if(typeof devicejs === 'function') {
                        devicejs = devicejs(relayRouter, relayEvents);
                        devicedb = devicedb(relayRouter);
                    }

                    function moveAccessTokenToReq(req, res, next) {
                        try {
                            var access_token = req.cookies.access_token;

                            if(typeof access_token === 'string') {
                                req.headers.authorization = 'Bearer ' + access_token;
                            }
                        }
                        catch(e) {
                            next(e);
                        }

                        next();
                    }

                    function _getDeviceJSAPIKeyFromUserID(userID) {
                        return userServiceClient.getAccounts(userID).then(function(accounts) {
                            if(accounts.length == 1) {
                                return accountServiceClient.getRelays(accounts[0]);
                            }
                            else {
                                throw { code: ERRS.HTTP.shortCode['NO_ACCOUNT'].status, reason: ERRS.HTTP.shortCode['NO_ACCOUNT'].statusText };
                            }
                        }).then(function(relays) {
                            if(relays.length == 1) {
                                return relays[0];
                            }
                            else {
                                throw { ERRS.HTTP.shortCode['NO_API_KEY'].status, reason: ERRS.HTTP.shortCode['NO_API_KEY'].statusText };
                            }
                        });
                    }

                    function getDeviceJSAPIKeyFromUserID(req, res, next) {
                        var userID = req.user.userID;

                        _getDeviceJSAPIKeyFromUserID(userID).then(function(devicejsAPIKey) {
                            req.devicejsAPIKey = devicejsAPIKey;
                            next();
                        }, function(error) {
                            res.status(error.code).send(error.reason);
                        });
                    }

                    console.log('SETUP CLOUD APP 2');

                    app.use(cookieParser());

                    if(requireAuth) {
                        requireAuth.forEach(function(route) {
                            if(route.method == 'get' ||
                               route.method == 'post' ||
                               route.method == 'put' || 
                               route.method == 'delete') {
                                var method = app[route.method].bind(app);
                            }
                            else {
                                var method = app.use.bind(app);
                            }

                            function attachDevHandles(req, res, next) {
                                var devicejsAPIKey = req.devicejsAPIKey;
                                var dev$ = devicejs.createClient(devicejsAPIKey);
                                var ddb = devicedb.createClient(devicejsAPIKey);

                                req.dev$ = dev$;
                                req.ddb = ddb;
                                next();
                            }

                            if(route.path) {
                                method(route.path, moveAccessTokenToReq, authenticate, getDeviceJSAPIKeyFromUserID, attachDevHandles);
                            }
                            else {
                                method(moveAccessTokenToReq, authenticate, getDeviceJSAPIKeyFromUserID, attachDevHandles);
                            }

                        });
                    }

                    setupAppCB(app, utils);
                },
                appID: appID
            }
        }
        else {
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
                                console.log(route);
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
                    log.error('Error in devicejs-rest-app setup', error);
                });
            });

            return {
            };
        }
    }
};
