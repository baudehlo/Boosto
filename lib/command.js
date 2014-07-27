"use strict";

var config      = require('./config');
var logger      = require('./logger');
var plugins     = require('./plugins');
var constants   = require('./constants');

var OK = "OK";
var NO = "NO";
var BAD = "BAD";
var PREAUTH = "PREAUTH";
var CRLF = "\r\n";

function Command (connection, tag, cmd, rest) {
    this.connection = connection;
    this.tag = tag;
    this.cmd = cmd;
}

exports.Command = Command;

exports.process_cmd = function (connection, tag, cmd, rest) {
    var command = new Command(connection, tag, cmd, rest);
    var method = 'cmd_' + cmd.toLowerCase();
    if (command[method]) {
        command[method](rest);
    }
    else {
        // unrecognised command
        console.log("No definition for " + method);
        plugins.run_hooks('unrecognized_command', command, [cmd, rest]);
    }

}

Command.prototype.respond = function(code, msg, lines, func) {
    if (code == "OK") {
        if (msg) {
            this.connection.respond("*", this.cmd == 'LOGOUT' ? "BYE" : this.cmd, msg);
            this.connection.respond(this.tag, OK, this.cmd + " completed");
        }
        else {
            this.connection.respond(this.tag, OK, this.cmd + " completed");
        }
    }
    else {
        this.connection.respond(this.tag, code, msg, lines, func);
    }
}

Command.prototype.cmd_capability = function () {
    this.respond(OK, "IMAP4rev1 STARTTLS LOGINDISABLED AUTH=PLAIN");
}

Command.prototype.unrecognized_command_respond = function (retval, msg) {
    console.log("ucr");
    this.respond(BAD, "No Such Command");
}

Command.prototype.cmd_login = function (rest) {
    this.logdebug("Login...");
    this.respond(OK);
}

Command.prototype.cmd_logout = function (rest) {
    this.respond(OK, "IMAP4rev1 BOOSTO Logging out");
    this.connection.disconnect();
}

Command.prototype.cmd_select = function (rest) {
    console.log("Select: ", rest);
}

Command.prototype.cmd_list = function (rest) {
    
}

Command.prototype.cmd_status = function (rest) {
    
}


// copy logger methods into Command:
for (var key in logger) {
    if (key.match(/^log\w/)) {
        Command.prototype[key] = (function (key) {
            return function () {
                // pass the connection instance to logger
                var args = [ this ];
                for (var i=0, l=arguments.length; i<l; i++) {
                    args.push(arguments[i]);
                }
                logger[key].apply(logger, args);
            }
        })(key);
    }
}

