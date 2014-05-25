"use strict";

// copied from http://www.broofa.com/Tools/Math.uuid.js
var CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');

exports.uuid = function () {
    var chars = CHARS, uuid = new Array(36), rnd=0, r;
    for (var i = 0; i < 36; i++) {
        if (i==8 || i==13 ||  i==18 || i==23) {
            uuid[i] = '-';
        } 
        else if (i==14) {
            uuid[i] = '4';
        }
        else {
            if (rnd <= 0x02) rnd = 0x2000000 + (Math.random()*0x1000000)|0;
            r = rnd & 0xf;
            rnd = rnd >> 4;
            uuid[i] = chars[(i == 19) ? (r & 0x3) | 0x8 : r];
        }
    }
    return uuid.join('');
};

exports.in_array = function (item, array) {
    return (array.indexOf(item) != -1);
};

exports.sort_keys = function (obj) {
    return Object.keys(obj).sort();
};

exports.uniq = function (arr) {
    var out = [];
    var o = 0;
    for (var i=0,l=arr.length; i < l; i++) {
        if (out.length === 0) {
            out.push(arr[i]);
        }
        else if (out[o] != arr[i]) {
            out.push(arr[i]);
            o++;
        }
    }
    return out;
}

exports.ISODate = function (d) {
   function pad(n) {return n<10 ? '0'+n : n}
   return d.getUTCFullYear()+'-'
      + pad(d.getUTCMonth()+1)+'-'
      + pad(d.getUTCDate())+'T'
      + pad(d.getUTCHours())+':'
      + pad(d.getUTCMinutes())+':'
      + pad(d.getUTCSeconds())+'Z'
}

var _daynames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var _monnames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _pad (num, n, p) {
    var s = '' + num;
    p = p || '0';
    while (s.length < n) s = p + s;
    return s;
}

exports.pad = _pad;

exports.date_to_str = function (d) {
    return _daynames[d.getDay()] + ', ' + _pad(d.getDate(),2) + ' ' +
           _monnames[d.getMonth()] + ' ' + d.getFullYear() + ' ' +
           _pad(d.getHours(),2) + ':' + _pad(d.getMinutes(),2) + ':' + _pad(d.getSeconds(),2) +
           ' ' + d.toString().match(/\sGMT([+-]\d+)/)[1];
}

var versions   = process.version.split('.'),
    version    = Number(versions[0].substring(1)),
    subversion = Number(versions[1]);

exports.existsSync = require((version > 0 || subversion >= 8) ? 'fs' : 'path').existsSync;

exports.indexOfLF = function (buf, maxlength) {
    for (var i=0; i<buf.length; i++) {
        if (maxlength && (i === maxlength)) break;
        if (buf[i] === 0x0a) return i;
    }
    return -1;
}

exports.prettySize = function (size) {
    if (size === 0 || !size) return 0;
    var i = Math.floor(Math.log(size)/Math.log(1024));
    var units = ['B', 'kB', 'MB', 'GB', 'TB'];
    return (size/Math.pow(1024,i)).toFixed(2) * 1 + '' + units[i];
}
