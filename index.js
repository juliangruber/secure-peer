var crypto = require('crypto');
var through = require('through');
var es = require('event-stream');

var createAck = require('./lib/ack');
var frame = require('./lib/frame');
var hash =require('./lib/hash');
var verify =require('./lib/verify');
var pad = require('./lib/pad');

module.exports = function (keys) {
    var group = 'modp5';
    var dh = crypto.getDiffieHellman(group);
    dh.generateKeys();
    dh.group = group;
    
    return function (cb) {
        return securePeer(dh, keys, cb);
    };
};

function securePeer (dh, keys, cb) {
    var stream, encrypt, decrypt;
    
    function unframer (buf) {
        var uf = frame.unpack(stream.id.key.public, buf);
        if (uf === 'end') {
            stream.emit('end');
            sec.emit('end');
            
            stream.emit('close');
            sec.emit('close');
            return;
        }
        if (!uf) {
            stream.destroy();
            sec.destroy();
            return;
        }
        var msg = Buffer(uf[0], 'base64');
        var s = decrypt.update(String(msg));
        stream.emit('data', Buffer(s).slice(0, uf[1]));
    }
    
    var firstLine = true;
    var lines = [];
    
    var sec = es.connect(es.split(), through(function (line) {
        if (!firstLine && decrypt) return unframer(line);
        else if (!firstLine) return lines.push(line);
        
        firstLine = false;
        
        try {
            var header = JSON.parse(line);
        } catch (e) { return sec.destroy() }
        
        sec.emit('header', header);
    }));
    
    sec.on('accept', function (ack) {
        var pub = ack.payload.dh.public;
        var k = dh.computeSecret(pub, 'base64', 'base64');
        
        encrypt = crypto.createCipher('aes-256-cbc', k);
        
        stream = through(write, end);
        stream.id = ack;
        
        sec.once('end', end);
        
        function write (buf) {
            var s = encrypt.update(String(pad(buf)));
            sec.emit('data', frame.pack(keys.private, Buffer(s), buf.length));
        }
        
        var sentEnd = false;
        function end () {
            if (sentEnd) return;
            sentEnd = true;
            sec.emit('data', '[]\n');
        }
        
        sec.emit('connection', stream);
        decrypt = crypto.createDecipher('aes-256-cbc', k);
        
        lines.forEach(unframer);
        lines = undefined;
    });
    
    sec.once('header', function (meta) {
        var payload = JSON.parse(meta.payload);
        
        var v = verify(payload.key.public, meta.payload, meta.hash);
        if (!v) return sec.reject();
        
        var ack = createAck(sec.listeners('identify').length);
        ack.key = payload.key;
        ack.outgoing = outgoing;
        ack.payload = payload;
        
        ack.on('accept', function () {
            sec.emit('accept', ack);
        });
        
        ack.on('reject', function () {
            sec.emit('close');
        });
        
        sec.emit('identify', ack);
    });
    
    sec.on('pipe', function () {
        process.nextTick(sendOutgoing);
    });
    
    var outgoing;
    function sendOutgoing () {
        outgoing = JSON.stringify({
            key : {
                type : 'rsa',
                public : keys.public,
            },
            dh : {
                group : dh.group,
                public : dh.getPublicKey('base64')
            }
        });
        sec.emit('data', JSON.stringify({
            hash : hash(keys.private, outgoing),
            payload : outgoing
        }) + '\n');
    }
    
    if (typeof cb === 'function') sec.on('connection', cb);
    return sec;
};
