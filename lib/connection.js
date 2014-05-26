"use strict";
// a single connection
var path        = require('path');
var config      = require('./config');
var logger      = require('./logger');
var sesion      = require('./session');
var dns         = require('dns');
var plugins     = require('./plugins');
var constants   = require('./constants');
var fs          = require('fs');
var uuid        = require('./utils').uuid;
var date_to_str = require('./utils').date_to_str;
var indexOfLF   = require('./utils').indexOfLF;
var ipaddr      = require('ipaddr.js');

var package_json_path = process.env.BOOSTO
                    ? path.join(process.env.BOOSTO, 'package.json')
                    : path.join(__dirname, '..', 'package.json');

var version  = JSON.parse(fs.readFileSync(package_json_path)).version;

var line_regexp = /^([^\n]*\n)/;

var connection = exports;

var states = exports.states = {
    STATE_CMD:             1,
    STATE_LOOP:            2,
    STATE_DATA:            3,
    STATE_PAUSE:           4,
    STATE_PAUSE_SMTP:      5,
    STATE_PAUSE_DATA:      6,
    STATE_DISCONNECTING:   99,
    STATE_DISCONNECTED:    100,
};

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
    this.state = states.STATE_PAUSE;
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

    if (this.state >= states.STATE_DISCONNECTING) {
        if (logger.would_log(logger.LOGPROTOCOL)) {
            this.logprotocol("C: (after-disconnect): " + this.current_line + ' state=' + this.state);
        }
        this.logwarn("data after disconnect from " + this.remote_ip);
        return;
    }

    if (this.state === states.STATE_DATA) {
        if (logger.would_log(logger.LOGDATA)) {
            this.logdata("C: " + line);
        }
        this.accumulate_data(line);
        return;
    }

    this.current_line = line.toString('binary').replace(/\r?\n/, '');
    if (logger.would_log(logger.LOGPROTOCOL)) {
        this.logprotocol("C: " + this.current_line + ' state=' + this.state);
    }

    // Check for non-ASCII characters
    if (/[^\x00-\x7F]/.test(this.current_line)) {
        return this.respond(501, 'Syntax error (8-bit characters not allowed)');
    }

    if (this.state === states.STATE_CMD) {
        this.state = states.STATE_PAUSE_SMTP;
        var matches = /^([^ ]*)( +(.*))?$/.exec(this.current_line);
        if (!matches) {
            return plugins.run_hooks('unrecognized_command', this, this.current_line);
        }
        var method = "cmd_" + matches[1].toLowerCase();
        var remaining = matches[3] || '';
        if (this[method]) {
            try {
                this[method](remaining);
            }
            catch (err) {
                if (err.stack) {
                    var c = this;
                    c.logerror(method + " failed: " + err);
                    err.stack.split("\n").forEach(c.logerror);
                }
                else {
                    this.logerror(method + " failed: " + err);
                }
                this.respond(421, "Internal Server Error", function() {
                    self.disconnect();
                });
            }
        }
        else {
            // unrecognised command
            matches.splice(0,1);
            matches.splice(1,1);
            plugins.run_hooks('unrecognized_command', this, matches);
        }
    }
    else if (this.state === states.STATE_LOOP) {
        // Allow QUIT
        if (this.current_line.toUpperCase() === 'QUIT') {
            this.cmd_quit();
        }
        else {
            this.respond(this.loop_code, this.loop_msg);
        }
    }
    else {
        throw new Error('unknown state ' + this.state);
    }
};

Connection.prototype.process_data = function (data) {
    if (this.state >= states.STATE_DISCONNECTING) {
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
    if (this.state >= states.STATE_DISCONNECTING) return;

    var maxlength;
    if (this.state === states.STATE_PAUSE_DATA || this.state === states.STATE_DATA) {
        maxlength = this.max_data_line_length;
    }
    else {
        maxlength = this.max_line_length;
    }

    var offset;
    while (this.current_data && ((offset = indexOfLF(this.current_data, maxlength)) !== -1)) {
        if (this.state === states.STATE_PAUSE_DATA) {
            return;
        }
        var this_line = this.current_data.slice(0, offset+1);
        // Hack: bypass this code to allow HAProxy's PROXY extension
        if (this.state === states.STATE_PAUSE && this.proxy && /^PROXY /.test(this_line)) {
            if (this.proxy_timer) clearTimeout(this.proxy_timer);
            this.state = states.STATE_CMD;
            this.current_data = this.current_data.slice(this_line.length);
            this.process_line(this_line);
        }
        // Detect early_talker but allow PIPELINING extension (ESMTP)
        else if ((this.state === states.STATE_PAUSE || this.state === states.STATE_PAUSE_SMTP) && !this.esmtp) {
            if (!this.early_talker) {
                this_line = this_line.toString().replace(/\r?\n/,'');
                this.logdebug('[early_talker] state=' + this.state + ' esmtp=' + this.esmtp + ' line="' + this_line + '"');
            }
            this.early_talker = 1;
            var self = this;
            // If you talk early, we're going to give you a delay
            setTimeout(function() { self._process_data() }, this.early_talker_delay);
            break;
        }
        else if ((this.state === states.STATE_PAUSE || this.state === states.STATE_PAUSE_SMTP) && this.esmtp) {
            var valid = true;
            var cmd = this_line.toString('ascii').slice(0,4).toUpperCase();
            switch (cmd) {
                case 'RSET':
                case 'MAIL':
                case 'SEND':
                case 'SOML':
                case 'SAML':
                case 'RCPT':
                    // These can be anywhere in the group
                    break;
                default:
                    // Anything else *MUST* be the last command in the group
                    if (this_line.length !== this.current_data.length) {
                        valid = false;
                    }
                    break;
            }
            if (valid) {
                // Valid PIPELINING
                // We *don't want to process this yet otherwise the
                // current_data buffer will be lost.  The respond()
                // function will call this function again once it
                // has reset the state back to states.STATE_CMD and this
                // ensures that we only process one command at a
                // time.
                this.pipelining = 1;
                this.logdebug('pipeline: ' + this_line);
            }
            else {
                // Invalid pipeline sequence
                // Treat this as early talker
                if (!this.early_talker) {
                    this.logdebug('[early_talker] state=' + this.state + ' esmtp=' + this.esmtp + ' line="' + this_line + '"');
                }
                this.early_talker = 1;
                var self = this;
                setTimeout(function() { self._process_data() }, this.early_talker_delay);
            }
            break;
        }
        else {
            this.current_data = this.current_data.slice(this_line.length);
            this.process_line(this_line);
        }
    }

    if (this.current_data && (this.current_data.length > maxlength) && (indexOfLF(this.current_data, maxlength) == -1)) {
        if (this.state !== states.STATE_DATA       &&
            this.state !== states.STATE_PAUSE_DATA)
        {
            // In command mode, reject:
            this.client.pause();
            this.current_data = null;
            return this.respond(521, "Command line too long", function () {
                self.disconnect();
            });
        }
        else {
            this.logwarn('DATA line length (' + this.current_data.length + ') exceeds limit of ' + maxlength + ' bytes');
            this.transaction.notes.data_line_length_exceeded = true;
            var b = Buffer.concat([
                this.current_data.slice(0, maxlength - 2),
                new Buffer("\r\n ", 'utf8'),
                this.current_data.slice(maxlength - 2)
            ], this.current_data.length + 3);
            this.current_data = b;
            return this._process_data();
        }
    }
};

Connection.prototype.respond = function(code, msg, func) {
    var uuid = '';
    var messages;

    if (this.state === states.STATE_DISCONNECTED) {
        if (func) func();
        return;
    }
    // Check to see if DSN object was passed in
    if (typeof msg === 'object' && msg.constructor.name === 'DSN') {
        // Override
        code = msg.code;
        msg = msg.reply;
    }
    if (!(Array.isArray(msg))) {
        // msg not an array, make it so:
        messages = msg.toString().split(/\n/).filter(function (msg) { return /\S/.test(msg) });
    } else {
        // copy
        messages = msg.slice().filter(function (msg) { return /\S/.test(msg) });
    }

    if (code >= 400) {
        this.last_reject = code + ' ' + messages.join(' ');
        if (this.deny_includes_uuid) {
            uuid = (this.transaction || this).uuid;
            if (this.deny_includes_uuid > 1) {
                uuid = uuid.substr(0, this.deny_includes_uuid);
            }
        }
    }

    var mess;
    var buf = '';

    while (mess = messages.shift()) {
        var line = code + (messages.length ? "-" : " ") +
            (uuid ? '[' + uuid + '] ' : '' ) + mess;
        this.logprotocol("S: " + line);
        buf = buf + line + "\r\n";
    }

    try {
        this.client.write(buf);
    }
    catch (err) {
        return this.fail("Writing response: " + buf + " failed: " + err);
    }

    // Store the last response
    this.last_response = buf;

    // Don't change loop state
    if (this.state !== states.STATE_LOOP) {
        this.state = states.STATE_CMD;
    }

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
    this.reset_transaction(function () {
        plugins.run_hooks('disconnect', self);
    });
};

Connection.prototype.disconnect_respond = function () {
    var logdetail = [
        'ip='    + this.remote_ip,
        'rdns="' + ((this.remote_host) ? this.remote_host : '') + '"',
        'helo="' + ((this.hello_host) ? this.hello_host : '') + '"',
        'relay=' + (this.relaying ? 'Y' : 'N'),
        'early=' + (this.early_talker ? 'Y' : 'N'),
        'esmtp=' + (this.esmtp ? 'Y' : 'N'),
        'tls='   + (this.using_tls ? 'Y' : 'N'),
        'pipe='  + (this.pipelining ? 'Y' : 'N'),
        'txns='  + this.tran_count,
        'rcpts=' + this.rcpt_count.accept + '/' +
                   this.rcpt_count.tempfail + '/' +
                   this.rcpt_count.reject,
        'msgs='  + this.msg_count.accept + '/' +
                   this.msg_count.tempfail + '/' +
                   this.msg_count.reject,
        'bytes=' + this.totalbytes,
        'lr="'   + ((this.last_reject) ? this.last_reject : '') + '"',
        'time='  + (Date.now() - this.start_time)/1000,
    ];
    this.lognotice('disconnect ' + logdetail.join(' '));
    this.state = states.STATE_DISCONNECTED;
    this.client.end();
};

Connection.prototype.get_capabilities = function() {
    var capabilities = []

    return capabilities;
};

