'use strict';

var endpoints = require("../data/endpoints.js");

function ConversationModel(data, api) {
	this.id = data._id;
	this.api = api;
	this.created_time = data.created;
	this.last_message_time = data.latest_message;
	this.participants = data.usersid;

	if (data.latest_message_str) this.last_message = data.latest_message_str;
}

ConversationModel.prototype.sendChat = function(message, callback) {
	if (typeof message !== 'string') throw new TypeError('message must be a string');

	var body = {};

	body.message = message;
	body.messageid = "";
	body.userid = this.api._.self.id;
	body.created = Date.now();

	this.api._.reqHandler.queue({method: 'POST', url: endpoints.messageConv.replace("%CONVID%", this.id), body: body }, callback);
}

module.exports = ConversationModel;