var cookieParser = require('cookie-parser');
var express = require('express');
var http = require('http');

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
    createApp: function(appID, requireAuth, setupApp) {
        if(arguments.length == 2) {
            setupApp = arguments[1];
            requireAuth = false;
        }

        if(this.isCloud()) {
            return {
                setup: function(app, utils) {
                    console.log('SETP CLOUD APP');
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
                                throw { code: 500, reason: 'No account tied to user' };
                            }
                        }).then(function(relays) {
                            if(relays.length == 1) {
                                return relays[0];
                            }
                            else {
                                throw { code: 500, reason: 'No DeviceJS API key tied to account' };
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

                    console.log('SETP CLOUD APP 2');

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

                    setupApp(app, utils);
                },
                appID: appID
            }
        }
        else {
            var app = express();
            var server = http.createServer(app);

            app.use(cookieParser());
            app.use(function(req, res, next) {
                    req.dev$ = dev$;
                req.ddb = ddb;
                next();
            });

            if(!requireAuth) {
                requireAuth = [ ];
            }
            
            setupApp(app);

            var appServer = dev$.selectByType('AppServer');

            console.log('look for app server');
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
                            console.log('Listening on port', portNumber);
                            server.listen(portNumber);
                        }, function(error) {
                            console.log('Error starting app', error);
                        });
                    }
                    else {
                        console.error('Could not register APIProxy with app server');
                    }
                }, function(error) {
                    console.log('ERROR', error);
                });
            });

            return {
            };
        }
    }
};
