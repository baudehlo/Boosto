#!/usr/bin/env node

"use strict";

var path = require('path');

// this must be set before "server.js" is loaded
process.env.BOOSTO = process.env.BOOSTO || path.resolve('.');
try {
    require.paths.push(path.join(process.env.BOOSTO, 'node_modules'));
}
catch(e) {
    process.env.NODE_PATH = process.env.NODE_PATH ? 
            (process.env.NODE_PATH + ':' + path.join(process.env.BOOSTO, 'node_modules'))
            :
            (path.join(process.env.BOOSTO, 'node_modules'));
    require('module')._initPaths(); // Horrible hack
}

var fs     = require('fs');
var logger = require('./lib/logger');
var server = require('./lib/server');

exports.version = JSON.parse(
        fs.readFileSync(path.join(__dirname, './package.json'), 'utf8')
    ).version;

process.on('uncaughtException', function (err) {
    if (err.stack) {
        err.stack.split("\n").forEach(function (line) {
            logger.logcrit(line);
        });
    }
    else {
        logger.logcrit('Caught exception: ' + JSON.stringify(err));
    }
    logger.dump_logs();
    process.exit(1);
});

['SIGTERM', 'SIGINT'].forEach(function (sig) {
    process.on(sig, function () {
        process.title = path.basename(process.argv[1], '.js');
        logger.lognotice(sig + ' received');
        logger.dump_logs(1);
    });
});

process.on('SIGHUP', function () {
    logger.lognotice("Flushing the temp fail queue");
    server.flushQueue();
})

process.on('exit', function() {
    process.title = path.basename(process.argv[1], '.js');
    logger.lognotice('Shutting down');
    logger.dump_logs();
});

logger.log("NOTICE", "Starting up Boosto version " + exports.version);

server.createServer();
