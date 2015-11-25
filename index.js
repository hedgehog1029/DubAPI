
var util = require('util'),
    eventEmitter = require('events').EventEmitter,
    pubnub = require('pubnub');

var MediaModel = require('./lib/models/mediaModel.js'),
    PlayModel = require('./lib/models/playModel.js'),
    RoomModel = require('./lib/models/roomModel.js'),
    SelfModel = require('./lib/models/selfModel.js'),
    UserModel = require('./lib/models/userModel.js');

var RequestHandler = require('./lib/requestHandler.js'),
    ActionHandler = require('./lib/actionHandler.js'),
    EventHandler = require('./lib/eventHandler.js');

var DubAPIError = require('./lib/errors/error.js'),
    DubAPIRequestError = require('./lib/errors/requestError.js');

var utils = require('./lib/utils.js'),
    events = require('./lib/data/events.js'),
    roles = require('./lib/data/roles.js'),
    package = require('./package.json'),
    endpoints = require('./lib/data/endpoints.js');

function DubAPI(auth, callback) {

    if (typeof auth !== 'object') throw new TypeError('auth must be an object');

    if (typeof auth.username !== 'string') throw new TypeError('auth.username must be a string');
    if (typeof auth.password !== 'string') throw new TypeError('auth.password must be a string');

    if (typeof callback !== 'function') throw new TypeError('callback must be a function');

    var that = this;

    eventEmitter.call(this);

    this._ = {};

    this._.connected = false;
    this._.actHandler = new ActionHandler(this, auth);
    this._.reqHandler = new RequestHandler(this);
    this._.pubNub = undefined;

    this._.slug = undefined;
    this._.self = undefined;
    this._.room = undefined;

    this.mutedTriggerEvents = false;

    this._.actHandler.doLogin(function(err) {
        if (err) return callback(err);

        that._.reqHandler.queue({method: 'GET', url: endpoints.authSession}, function(code, body) {
            if (code !== 200) return callback(new DubAPIRequestError(code, that._.reqHandler.endpoint(endpoints.authSession)));

            that._.self = new SelfModel(body.data);

            that._.pubNub = pubnub({
                backfill: false,
                subscribe_key: 'sub-c-2b40f72a-6b59-11e3-ab46-02ee2ddab7fe',
                ssl: true,
                uuid: that._.self.id
            });

            callback(undefined, that);
        });
    });
}

util.inherits(DubAPI, eventEmitter);

DubAPI.prototype.events = events;
DubAPI.prototype.roles = roles;
DubAPI.prototype.version = package.version;

/*
 * External Functions
 */

DubAPI.prototype.connect = function(slug) {
    if (this._.slug !== undefined) return;

    this._.slug = slug;

    var that = this;

    that._.reqHandler.queue({method: 'GET', url: endpoints.room}, function(code, body) {
        if (code !== 200) {
            that.emit('error', new DubAPIRequestError(code, that._.reqHandler.endpoint(endpoints.room)));
            return that.disconnect();
        }

        that._.room = new RoomModel(body.data);

        that._.pubNub.subscribe({
            channel: that._.room.realTimeChannel,
            callback: EventHandler.bind(that),
            connect: that.emit.bind(that, 'pubnub:connect'),
            reconnect: that.emit.bind(that, 'pubnub:reconnect'),
            disconnect: that.emit.bind(that, 'pubnub:disconnect'),
            error: that.emit.bind(that, 'error')
        });

        that._.reqHandler.queue({method: 'POST', url: endpoints.roomUsers}, function(code, body) {
            if ([200, 401].indexOf(code) === -1) {
                that.emit('error', new DubAPIRequestError(code, that._.reqHandler.endpoint(endpoints.roomUsers)));
                return that.disconnect();
            } else if (code === 401) {
                that.emit('error', new DubAPIError(that._.self.username + ' is banned from ' + that._.room.name));
                return that.disconnect();
            }

            that._.reqHandler.queue({method: 'GET', url: endpoints.roomUsers}, function(code, body) {
                if (code !== 200) {
                    that.emit('error', new DubAPIRequestError(code, that._.reqHandler.endpoint(endpoints.roomUsers)));
                    return that.disconnect();
                }

                body.data.map(function(data) {return new UserModel(data);}).forEach(function(userModel) {
                    that._.room.users.add(userModel);
                });

                that._.actHandler.updatePlay();
                that._.actHandler.updateQueue();

                that._.connected = true;
                that.emit('connected', that._.room.name);
            });
        });
    });
};

DubAPI.prototype.disconnect = function() {
    if (this._.slug === undefined) return;

    var name = this._.room ? this._.room.name : undefined;

    if (this._.room) {
        clearTimeout(this._.room.playTimeout);

        this._.pubNub.unsubscribe({
            channel: this._.room.realTimeChannel,
        });

        this._.reqHandler.queue({method: 'DELETE', url: endpoints.roomUsers});
    }

    this._.slug = undefined;
    this._.room = undefined;

    if (this._.connected) {
        this.emit('disconnected', name);
        this._.connected = false;
    }
};

DubAPI.prototype.reconnect = function() {
    if (this._.slug === undefined) return;

    var slug = this._.slug;

    this.disconnect();
    this.connect(slug);
};

DubAPI.prototype.sendChat = function(message) {
    if (!this._.connected) return;

    if (typeof message !== 'string') throw new TypeError('message must be a string');

    message = message.trim();

    if (message.length === 0) throw new Error('message cannot be empty');

    message = utils.encodeHTMLEntities(message);

    message = message.match(/(.{1,140})(?:\s|$)|(.{1,140})/g);

    var body = {};

    body.type = 'chat-message';
    body.realTimeChannel = this._.room.realTimeChannel;

    for (var i = 0; i < message.length; i++) {
        body.time = Date.now();
        body.message = message[i];

        this._.reqHandler.queue({method: 'POST', url: endpoints.chat, body: utils.clone(body), isChat: true});
    }
};

DubAPI.prototype.getChatHistory = function() {
    if (!this._.connected) return [];

    return utils.clone(this._.room.chat, {deep: true});
};

DubAPI.prototype.getRoomMeta = function() {
    if (!this._.connected) return;

    return this._.room.getMeta();
};

DubAPI.prototype.getQueue = function() {
    if (!this._.connected) return [];

    return utils.clone(this._.room.queue, {deep: true});
};

/*
 * Moderation Functions
 */

DubAPI.prototype.moderateSkip = function(callback) {
    if (!this._.connected || !this._.room.play) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('skip')) return;

    if (this._.room.play.skipped) return;

    var form = {realTimeChannel: this._.room.realTimeChannel},
        uri = endpoints.chatSkip.replace('%PID%', this._.room.play.id);

    this._.reqHandler.queue({method: 'POST', url: uri, form: form}, callback);
};

DubAPI.prototype.moderateDeleteChat = function(id, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('delete-chat')) return;

    if (typeof id !== 'string') throw new TypeError('id must be a string');

    this._.reqHandler.queue({method: 'DELETE', url: endpoints.chatDelete.replace('%CID%', id)}, callback);
};

DubAPI.prototype.moderateBanUser = function(id, time, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('ban')) return;

    var user = this._.room.users.findWhere({id: id});
    if (user && user.role !== null) return;

    if (typeof time === 'function') {
        callback = time;
        time = undefined;
    }

    if (typeof id !== 'string') throw new TypeError('id must be a string');
    if (['number', 'undefined'].indexOf(typeof time) === -1) throw new TypeError('time must be undefined or a number');
    if (time && time < 0) throw new RangeError('time must be zero or greater');

    var form = {realTimeChannel: this._.room.realTimeChannel, time: time ? time : 0};

    this._.reqHandler.queue({method: 'POST', url: endpoints.chatBan.replace('%UID%', id), form: form}, callback);
};

DubAPI.prototype.moderateUnbanUser = function(id, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('ban')) return;

    if (typeof id !== 'string') throw new TypeError('id must be a string');

    var form = {realTimeChannel: this._.room.realTimeChannel};

    this._.reqHandler.queue({method: 'DELETE', url: endpoints.chatBan.replace('%UID%', id), form: form}, callback);
};

DubAPI.prototype.moderateKickUser = function(id, msg, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('kick')) return;

    var user = this._.room.users.findWhere({id: id});
    if (user && user.role !== null) return;

    if (typeof msg === 'function') {
        callback = msg;
        msg = undefined;
    }

    if (typeof id !== 'string') throw new TypeError('id must be a string');
    if (['string', 'undefined'].indexOf(typeof msg) === -1) throw new TypeError('msg must be a string or undefined');

    var form = {realTimeChannel: this._.room.realTimeChannel, message: msg ? utils.encodeHTMLEntities(msg) : ''};

    this._.reqHandler.queue({method: 'POST', url: endpoints.chatKick.replace('%UID%', id), form: form}, callback);
};

DubAPI.prototype.moderateMuteUser = function(id, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('mute')) return;

    var user = this._.room.users.findWhere({id: id});
    if (user && user.role !== null) return;

    if (typeof id !== 'string') throw new TypeError('id must be a string');

    var form = {realTimeChannel: this._.room.realTimeChannel};

    this._.reqHandler.queue({method: 'POST', url: endpoints.chatMute.replace('%UID%', id), form: form}, callback);
};

DubAPI.prototype.moderateUnmuteUser = function(id, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('mute')) return;

    if (typeof id !== 'string') throw new TypeError('id must be a string');

    var form = {realTimeChannel: this._.room.realTimeChannel};

    this._.reqHandler.queue({method: 'DELETE', url: endpoints.chatMute.replace('%UID%', id), form: form}, callback);
};

DubAPI.prototype.moderateRemoveDJ = function(id, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('queue-order')) return;

    if (typeof id !== 'string') throw new TypeError('id must be a string');

    this._.reqHandler.queue({method: 'DELETE', url: endpoints.roomQueueRemoveUser.replace('%UID%', id)}, callback);
};

DubAPI.prototype.moderateRemoveSong = function(id, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('queue-order')) return;

    if (typeof id !== 'string') throw new TypeError('id must be a string');

    this._.reqHandler.queue({method: 'DELETE', url: endpoints.roomQueueRemoveSong.replace('%UID%', id)}, callback);
};

DubAPI.prototype.moderateSetRole = function(id, role, callback) {
    if (!this._.connected) return;
    if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('set-roles')) return;

    if (typeof id !== 'string') throw new TypeError('id must be a string');
    if (typeof role !== 'string') throw new TypeError('role must be a string');
    if (roles[role] === undefined) throw new DubAPIError('role not found');

    var form = {realTimeChannel: this._.room.realTimeChannel};

    this._.reqHandler.queue({method: 'POST', url: endpoints.setRole.replace('%UID%', id).replace('%ROLEID%', roles[role].id), form: form}, callback);
};

DubAPI.prototype.moderateUnsetRole = function(id, role, callback) {
  if (!this._.connected) return;
  if (!this._.room.users.findWhere({id: this._.self.id}).hasPermission('set-roles')) return;

  if (typeof id !== 'string') throw new TypeError('id must be a string');
  if (typeof role !== 'string') throw new TypeError('role must be a string');
  if (roles[role] === undefined) throw new DubAPIError('role not found');

  var form = {realTimeChannel: this._.room.realTimeChannel};

  this._.reqHandler.queue({method: 'DELETE', url: endpoints.setRole.replace('%UID%', id).replace('%ROLEID%', role), form: form}, callback);
};

/*
 * Media Functions
 */

DubAPI.prototype.updub = function(callback) {
    if (!this._.connected || !this._.room.play || this._.room.play.dubs[this._.self.id] === 'updub') return;

    this._.reqHandler.queue({method: 'POST', url: endpoints.roomPlaylistActiveDubs, form: {type: 'updub'}}, callback);
};

DubAPI.prototype.downdub = function(callback) {
    if (!this._.connected || !this._.room.play || this._.room.play.dubs[this._.self.id] === 'downdub') return;

    this._.reqHandler.queue({method: 'POST', url: endpoints.roomPlaylistActiveDubs, form: {type: 'downdub'}}, callback);
};

DubAPI.prototype.getMedia = function() {
    if (!this._.connected || !this._.room.play) return;

    return utils.clone(this._.room.play.media);
};

DubAPI.prototype.getScore = function() {
    if (!this._.connected || !this._.room.play) return;

    return this._.room.play.getScore();
};

DubAPI.prototype.getPlayID = function() {
    if (!this._.connected || !this._.room.play) return;

    return this._.room.play.id;
};

DubAPI.prototype.getTimeRemaining = function() {
    if (!this._.connected || !this._.room.play) return -1;

    return this._.room.play.getTimeRemaining();
};

DubAPI.prototype.getTimeElapsed = function() {
    if (!this._.connected || !this._.room.play) return -1;

    return this._.room.play.getTimeElapsed();
};

/*
 * User Functions
 */

DubAPI.prototype.getUser = function(id) {
    if (!this._.connected) return;

    return utils.clone(this._.room.users.findWhere({id: id}));
};

DubAPI.prototype.getUserByName = function(username) {
    if (!this._.connected) return;

    return utils.clone(this._.room.users.findWhere({username: username}));
};

DubAPI.prototype.getSelf = function() {
    if (!this._.connected) return;

    return utils.clone(this._.room.users.findWhere({id: this._.self.id}));
};

DubAPI.prototype.getCreator = function() {
    if (!this._.connected) return;

    return utils.clone(this._.room.users.findWhere({id: this._.room.user}));
};

DubAPI.prototype.getDJ = function() {
    if (!this._.connected || !this._.room.play) return;

    return utils.clone(this._.room.users.findWhere({id: this._.room.play.user}));
};

DubAPI.prototype.getUsers = function() {
    if (!this._.connected) return [];

    return utils.clone(this._.room.users);
};

DubAPI.prototype.getStaff = function() {
    if (!this._.connected) return [];

    return utils.clone(this._.room.users.filter(function(user) {return user.role !== null;}));
};

/*
 * Role Functions
 */

DubAPI.prototype.isCreator = function(user) {
    if (!this._.connected || user === undefined) return false;
    return user.id === this._.room.user;
};

DubAPI.prototype.isOwner = function(user) {
    if (!this._.connected || user === undefined) return false;
    return user.role === roles['co-owner'].id;
};

DubAPI.prototype.isManager = function(user) {
    if (!this._.connected || user === undefined) return false;
    return user.role === roles['manager'].id;
};

DubAPI.prototype.isMod = function(user) {
    if (!this._.connected || user === undefined) return false;
    return user.role === roles['mod'].id;
};

DubAPI.prototype.isVIP = function(user) {
    if (!this._.connected || user === undefined) return false;
    return user.role === roles['vip'].id;
};

DubAPI.prototype.isResidentDJ = function(user) {
    if (!this._.connected || user === undefined) return false;
    return user.role === roles['resident-dj'].id;
};

DubAPI.prototype.isStaff = function(user) {
    if (!this._.connected || user === undefined) return false;
    return user.role !== null;
};

/*
 * Permission Functions
 */

DubAPI.prototype.hasPermission = function(user, permission) {
    if (!this._.connected || user === undefined) return false;
    return this._.room.users.findWhere({id: user.id}).hasPermission(permission);
};

module.exports = DubAPI;
