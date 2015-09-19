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
    createApp: function(appID, setupApp) {
        if(this.isCloud()) {
            return {
                setup: function(app, utils) {
                    console.log('SETP CLOUD APP');
                    var authenticate = utils.authenticate;
                    var relayRouter = utils.relayRouter;
                    var accountServiceClient = utils.accountServiceClient;
                    var userServiceClient = utils.userServiceClient;
                    var relayEvents = new RelayEventsExchange.Subscriber(utils.messageBrokerConnectionConfig);
                    devicejs = devicejs(relayRouter, relayEvents);
                    devicedb = devicedb(relayRouter);

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
                    app.use(cookieParser(), moveAccessTokenToReq, authenticate, getDeviceJSAPIKeyFromUserID, function(req, res, next) {
                        var devicejsAPIKey = req.devicejsAPIKey;
                        var dev$ = devicejs.createClient(devicejsAPIKey);
                        var ddb = devicedb.createClient(devicejsAPIKey);

                        req.dev$ = dev$;
                        req.ddb = ddb;
                        next();
                    });

                    setupApp(app);
                },
                appID: appID
            }
        }
        else {
            var app = express();
            var server = http.createServer(app);
            app.use(cookieParser(), function(req, res, next) {
                req.dev$ = dev$;
                req.ddb = ddb;
                next();
            });

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
                        console.log('Listening on port', portNumber);
                        server.listen(portNumber);
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
