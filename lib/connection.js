"use strict";
// a single connection
var path        = require('path');
var config      = require('./config');
var logger      = require('./logger');
var sesion      = require('./session');
var dns         = require('dns');
var plugins     = require('./plugins');
var constants   = require('./constants');
var command     = require('./command');
var fs          = require('fs');
var uuid        = require('./utils').uuid;
var date_to_str = require('./utils').date_to_str;
var indexOfLF   = require('./utils').indexOfLF;
var ipaddr      = require('ipaddr.js');

var package_json_path = process.env.BOOSTO
                    ? path.join(process.env.BOOSTO, 'package.json')
                    : path.join(__dirname, '..', 'package.json');

var version  = JSON.parse(fs.readFileSync(package_json_path)).version;

var connection = exports;

var states = exports.states = {
    STATE_UNAUTHENTICATED: 1,
    STATE_AUTHENTICATED:   2,
    STATE_SELECTED:        3,
    STATE_LOGOUT:          4,
};

var network_states = {
    STATE_CMD:             1,
    STATE_PAUSE:           2,
    STATE_DISCONNECTING:   99,
    STATE_DISCONNECTED:    100,
};

var OK = "OK";
var NO = "NO";
var BAD = "BAD";
var PREAUTH = "PREAUTH";
var CRLF = "\r\n";

// copy logger methods into Connection:
for (var key in logger) {
    if (key.match(/^log\w/)) {
        Connection.prototype[key] = (function (key) {
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

// Load HAProxy hosts into an object for fast lookups
// as this list is checked on every new connection.
var haproxy_hosts = {};
function loadHAProxyHosts() {
    var hosts = config.get('haproxy_hosts', 'list', function () {
        loadHAProxyHosts();
    });
    var new_host_list = [];
    for (var i=0; i<hosts.length; i++) {
        var host = hosts[i].split(/\//)
        new_host_list[i] = [ipaddr.IPv4.parse(host[0]), parseInt(host[1] || 32)];
    }
    haproxy_hosts = new_host_list;
}
loadHAProxyHosts();

function setupClient(self) {
    var ip = self.client.remoteAddress;
    if (!ip) {
        self.logdebug('setupClient got no IP address for this connection!');
        self.client.destroy();
        return;
    }

    var local_addr = self.server.address();
    if (local_addr && local_addr.address) {
        self.local_ip = ipaddr.process(local_addr.address).toString();
        self.local_port = local_addr.port;
    }
    self.remote_ip = ipaddr.process(ip).toString();
    self.remote_port = self.client.remotePort;
    self.lognotice('connect ip=' + self.remote_ip + ' port=' + self.remote_port +
                   ' local_ip=' + self.local_ip + ' local_port=' + self.local_port);

    self.client.on('end', function() {
        if (self.state >= states.STATE_DISCONNECTING) return;
        self.remote_close = true;
        self.fail('client ' + ((self.remote_host) ? self.remote_host + ' ' : '')
                            + '[' + self.remote_ip + '] half closed connection');
    });

    self.client.on('close', function(has_error) {
        if (self.state >= states.STATE_DISCONNECTING) return;
        self.remote_close = true;
        self.fail('client ' + ((self.remote_host) ? self.remote_host + ' ' : '')
                            + '[' + self.remote_ip + '] dropped connection');
    });

    self.client.on('error', function (err) {
        if (self.state >= states.STATE_DISCONNECTING) return;
        self.fail('client ' + ((self.remote_host) ? self.remote_host + ' ' : '')
                            + '[' + self.remote_ip + '] connection error: ' + err);
    });

    self.client.on('timeout', function () {
        if (self.state >= states.STATE_DISCONNECTING) return;
        self.respond(421, 'timeout', function () {
            self.fail('client ' + ((self.remote_host) ? self.remote_host + ' ' : '')
                                + '[' + self.remote_ip + '] connection timed out');
        });
    });

    self.client.on('data', function (data) {
        self.process_data(data);
    });

    if (haproxy_hosts.some(function (element, index, array) {
        return ipaddr.IPv4.parse(self.remote_ip).match(element[0], element[1]);
    })) {
        self.proxy = true;
        // Wait for PROXY command
        self.proxy_timer = setTimeout(function () {
            self.respond(421, 'PROXY timeout', function () {
                self.disconnect();
            });
        }, 30 * 1000);
    }
    else {
        plugins.run_hooks('connect', self);
    }
}

function Connection(client, server) {
    this.client = client;
    this.server = server;
    this.local_ip = null;
    this.local_port = null;
    this.remote_ip = null;
    this.remote_host = null;
    this.remote_port = null;
    this.remote_info = null;
    this.current_data = null;
    this.current_line = null;
    this.greeting = null;
    this.using_tls = server.has_tls ? true : false;
    this.state = states.STATE_UNAUTHENTICATED;
    this.network_state = network_states.STATE_CMD;
    this.prev_state = null;
    this.loop_code = null;
    this.loop_msg = null;
    this.uuid = uuid();
    this.notes = {};
    this.sessions = {};
    this.tran_count = 0;
    this.capabilities = null;
    this.last_response = null;
    this.remote_close = false;
    this.hooks_to_run = [];
    this.start_time = Date.now();
    this.last_reject = '';
    this.totalbytes = 0;
    this.proxy = false;
    this.proxy_timer = false;
    setupClient(this);
}

exports.Connection = Connection;

exports.createConnection = function(client, server) {
    var s = new Connection(client, server);
    return s;
}

Connection.prototype.process_line = function (line) {
    var self = this;

    if (this.network_state >= network_states.STATE_DISCONNECTING) {
        if (logger.would_log(logger.LOGPROTOCOL)) {
            this.logprotocol("C: (after-disconnect): " + this.current_line + ' state=' + this.network_state);
        }
        this.logwarn("data after disconnect from " + this.remote_ip);
        return;
    }

    this.current_line = line.toString('binary').replace(/\r?\n/, '');
    if (logger.would_log(logger.LOGPROTOCOL)) {
        this.logprotocol("C: " + this.current_line + ' state=' + this.state);
    }

    if (this.network_state === network_states.STATE_CMD) {
        var matches = /^([^ \(\)\{\%\*\\"\]]*) +(\S+)( +(.*?))?$/.exec(this.current_line);
        if (!matches) {
            console.log("Bad match");
            return plugins.run_hooks('unrecognized_command', this, this.current_line);
        }
        var tag = matches[1];
        var cmd = matches[2].toLowerCase();
        var remaining = matches[4] || '';
        command.process_cmd(this, tag, cmd, remaining);
    }
    else {
        throw new Error('unknown state ' + this.network_state + ' trying to process: ' + line);
    }
};

Connection.prototype.process_data = function (data) {
    if (this.network_state >= network_states.STATE_DISCONNECTING) {
        this.logwarn("data after disconnect from " + this.remote_ip);
        return;
    }

    if (!this.current_data || !this.current_data.length) {
        this.current_data = data;
    }
    else {
        // Data left over in buffer
        var buf = Buffer.concat(
            [ this.current_data, data ],
            (this.current_data.length + data.length)
        );
        this.current_data = buf;
    }
    
    this._process_data();
};

Connection.prototype._process_data = function() {
    var self = this;
    // We *must* detect disconnected connections here as the state
    // only transitions to states.STATE_CMD in the respond function below.
    // Otherwise if multiple commands are pipelined and then the
    // connection is dropped; we'll end up in the function forever.
    if (this.network_state >= network_states.STATE_DISCONNECTING) return;

    var maxlength;
    
    if (this.network_state === network_states.STATE_PAUSE) {
        maxlength = this.max_data_line_length;
    }
    else {
        maxlength = this.max_line_length;
    }

    var offset;
    while (this.current_data && ((offset = indexOfLF(this.current_data, maxlength)) !== -1)) {
        var this_line = this.current_data.slice(0, offset+1);
        this.current_data = this.current_data.slice(this_line.length);
        this.process_line(this_line);
    }

    if (this.current_data && (this.current_data.length > maxlength) && (indexOfLF(this.current_data, maxlength) == -1)) {
        this.client.pause();
        this.current_data = null;
        return this.respond(521, "Command line too long", function () {
            self.disconnect();
        });
    }
};

Connection.prototype.respond = function(tag, code, msg, lines, func) {
    if (this.network_state === network_states.STATE_DISCONNECTED) {
        if (func) func();
        return;
    }
    
    lines = lines || [];
    
    var line;
    var buf = '';
    for (var i=0; i<lines.length; i++) {
        line = "* " + lines[i] + CRLF;
        this.logprotocol("S: " + line);
        buf += line;
    }
    line = tag + " " + code + " " + msg + CRLF;
    this.logprotocol("S: " + line);
    buf += line;    
    
    this.client.write(buf);
    
    // Store the last response
    this.last_response = buf;

    // Don't change loop state
    this.network_state = network_states.STATE_CMD;

    // Run optional closure before handling and further commands
    if (func) func();

    // Process any buffered commands (PIPELINING)
    this._process_data();
};

Connection.prototype.fail = function (err) {
    this.logwarn(err);
    this.hooks_to_run = [];
    this.disconnect();
}

Connection.prototype.disconnect = function() {
    if (this.state >= states.STATE_DISCONNECTING) return;
    var self = this;
    self.state = states.STATE_DISCONNECTING;
    plugins.run_hooks('disconnect', self);
};

Connection.prototype.disconnect_respond = function () {
    var logdetail = [
        'ip='    + this.remote_ip,
        'rdns="' + ((this.remote_host) ? this.remote_host : '') + '"',
        'helo="' + ((this.hello_host) ? this.hello_host : '') + '"',
        'tls='   + (this.using_tls ? 'Y' : 'N'),
        'bytes=' + this.totalbytes,
        'time='  + (Date.now() - this.start_time)/1000,
    ];
    this.lognotice('disconnect ' + logdetail.join(' '));
    this.state = states.STATE_DISCONNECTED;
    this.client.end();
};

Connection.prototype.connect_respond = function () {
    this.respond("*", OK, "IMAP4rev1 BOOSTO Service Ready");
}

