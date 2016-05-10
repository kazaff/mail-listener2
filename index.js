var Imap = require('imap');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var MailParser = require("mailparser").MailParser;
var fs = require("fs");
var path = require('path');
var async = require('async');

module.exports = MailListener;

function MailListener(options) {
  this.markSeen = !! options.markSeen;
  this.mailbox = options.mailbox || "INBOX";
  if ('string' === typeof options.searchFilter) {
    this.searchFilter = [options.searchFilter];
  } else {
    this.searchFilter = options.searchFilter || ["UNSEEN"];
  }
  this.fetchUnreadOnStart = !! options.fetchUnreadOnStart;
  this.mailParserOptions = options.mailParserOptions || {};
  if (options.attachments && options.attachmentOptions && options.attachmentOptions.stream) {
    this.mailParserOptions.streamAttachments = true;
  }
  this.attachmentOptions = options.attachmentOptions || {};
  this.attachments = options.attachments || false;
  this.attachmentOptions.directory = (this.attachmentOptions.directory ? this.attachmentOptions.directory : '');
  this.imap = new Imap({
    xoauth2: options.xoauth2,
    user: options.username,
    password: options.password,
    host: options.host,
    port: options.port,
    tls: options.tls,
    tlsOptions: options.tlsOptions || {}
  });

  //绑定对应的事件
  this.imap.once('ready', imapReady.bind(this));
  this.imap.once('close', imapClose.bind(this));
  this.imap.on('error', imapError.bind(this));
}

util.inherits(MailListener, EventEmitter);  //这么做，我们的MailListener就拥有创建时间的功能了

MailListener.prototype.start = function() { //尝试连接邮件服务器
  this.imap.connect();
};

MailListener.prototype.stop = function() {
  this.imap.end();
};

function imapReady() {
  var self = this;
  this.imap.openBox(this.mailbox, false, function(err, mailbox) { //根据node-imap提供的openBox来请求指定的mailbox
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('server:connected');
      if (self.fetchUnreadOnStart) {  //是否在首次连接建立后直接触发获取所有未读信件
        parseUnread.call(self);
      }
      self.imap.on('mail', imapMail.bind(self));  //每当监听到新邮件时触发的事件及回调
    }
  });
}

function imapClose() {
  this.emit('server:disconnected');
}

function imapError(err) {
  this.emit('error', err);
}

function imapMail() {
  parseUnread.call(this);
}

function parseUnread() {
  var self = this;
  this.imap.search(self.searchFilter, function(err, results) {  //根据配置的过滤规则来获取信件
    if (err) {
      self.emit('error', err);
    } else if (results.length > 0) {
      async.each(results, function( result, callback) { //使用async库提供的并发循环来获取所有目标信件
        var f = self.imap.fetch(result, {   //获取指定UID的mail
          bodies: '',   //''相当于获取header + body
          markSeen: self.markSeen   //是否将该mail设置为已读
        });
        f.on('message', function(msg, seqno) {  //由于这里我们的ImapFetch只获取一个特定uid的mail，所以该事件只会触发一次
          var parser = new MailParser(self.mailParserOptions);
          var attributes = null;

          parser.on("end", function(mail) {
            if (!self.mailParserOptions.streamAttachments && mail.attachments && self.attachments) {  //根据配置判断是否需要将附件保存在指定磁盘位置
              async.each(mail.attachments, function( attachment, callback) {
                fs.writeFile(self.attachmentOptions.directory + attachment.generatedFileName, attachment.content, function(err) {
                  if(err) {
                    self.emit('error', err);  //触发自定义的error事件
                    callback()  //任何附件保存异常都忽略了，避免影响并发循环
                  } else {
                    attachment.path = path.resolve(self.attachmentOptions.directory + attachment.generatedFileName);
                    self.emit('attachment', attachment);
                    callback()
                  }
                });
              }, function(err){ //处理完所有附件，触发mail事件
                self.emit('mail', mail, seqno, attributes);
                callback()
              });
            } else {
              self.emit('mail', mail, seqno, attributes);
            }
          });
          parser.on("attachment", function (attachment, mail) { //每当解析完一个附件后会触发该事件，注意回调中的参数是一个流
            self.emit('attachment', attachment, mail);
          });
          msg.on('body', function(stream, info) { //ImapMessage每当解析完body的完整块后触发该事件
            stream.pipe(parser);  //以流的方式交给mailparser来解析
          });
          msg.on('attributes', function(attrs) {  //ImapMessage解析完消息的完整attributes后触发该事件
            attributes = attrs;
          });
        });
        f.once('error', function(err) {
          self.emit('error', err);
        });
      }, function(err){
        if( err ) {
          self.emit('error', err);
        }
      });
    }
  });
}
