/*!
 * coin.js - coin object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var assert = require('assert');
var util = require('../utils/util');
var constants = require('../protocol/constants');
var Network = require('../protocol/network');
var Amount = require('../btc/amount');
var Output = require('./output');
var Script = require('../script/script');
var Network = require('../protocol/network');
var BufferReader = require('../utils/reader');
var StaticWriter = require('../utils/staticwriter');

/**
 * Represents an unspent output.
 * @exports Coin
 * @constructor
 * @extends Output
 * @param {NakedCoin|Coin} options
 * @property {Number} version - Transaction version.
 * @property {Number} height - Transaction height (-1 if unconfirmed).
 * @property {Amount} value - Output value in satoshis.
 * @property {Script} script - Output script.
 * @property {Boolean} coinbase - Whether the containing
 * transaction is a coinbase.
 * @property {Hash} hash - Transaction hash.
 * @property {Number} index - Output index.
 */

function Coin(options) {
  if (!(this instanceof Coin))
    return new Coin(options);

  this.version = 1;
  this.height = -1;
  this.value = 0;
  this.script = new Script();
  this.coinbase = true;
  this.hash = constants.NULL_HASH;
  this.index = 0;

  if (options)
    this.fromOptions(options);
}

util.inherits(Coin, Output);

/**
 * Inject options into coin.
 * @private
 * @param {Object} options
 */

Coin.prototype.fromOptions = function fromOptions(options) {
  assert(options, 'Coin data is required.');
  assert(util.isNumber(options.version));
  assert(util.isNumber(options.height));
  assert(util.isNumber(options.value));
  assert(typeof options.coinbase === 'boolean');
  assert(options.hash == null || typeof options.hash === 'string');
  assert(options.index == null || util.isNumber(options.index));

  this.version = options.version;
  this.height = options.height;
  this.value = options.value;

  if (options.script)
    this.script.fromOptions(options.script);

  this.coinbase = options.coinbase;
  this.hash = options.hash;
  this.index = options.index;

  return this;
};

/**
 * Instantiate Coin from options object.
 * @private
 * @param {Object} options
 */

Coin.fromOptions = function fromOptions(options) {
  return new Coin().fromOptions(options);
};

/**
 * Calculate number of confirmations since coin was created.
 * @param {Number?} height - Current chain height. Network
 * height is used if not passed in.
 * @return {Number}
 */

Coin.prototype.getDepth = function getDepth(height) {
  assert(typeof height === 'number', 'Must pass a height.');

  if (this.height === -1)
    return 0;

  if (height < this.height)
    return 0;

  return height - this.height + 1;
};

/**
 * Serialize coin to a key
 * suitable for a hash table.
 * @returns {String}
 */

Coin.prototype.toKey = function toKey() {
  return this.hash + this.index;
};

/**
 * Inject properties from hash table key.
 * @private
 * @param {String} key
 * @returns {Coin}
 */

Coin.prototype.fromKey = function fromKey(key) {
  assert(key.length > 64);
  this.hash = key.slice(0, 64);
  this.index = +key.slice(64);
  return this;
};

/**
 * Instantiate coin from hash table key.
 * @param {String} key
 * @returns {Coin}
 */

Coin.fromKey = function fromKey(key) {
  return new Coin().fromKey(key);
};

/**
 * Convert the coin to a more user-friendly object.
 * @returns {Object}
 */

Coin.prototype.inspect = function inspect() {
  return {
    type: this.getType(),
    version: this.version,
    height: this.height,
    value: Amount.btc(this.value),
    script: this.script,
    coinbase: this.coinbase,
    hash: this.hash ? util.revHex(this.hash) : null,
    index: this.index,
    address: this.getAddress()
  };
};

/**
 * Convert the coin to an object suitable
 * for JSON serialization.
 * @returns {Object}
 */

Coin.prototype.toJSON = function toJSON() {
  return this.getJSON();
};

/**
 * Convert the coin to an object suitable
 * for JSON serialization. Note that the hash
 * will be reversed to abide by bitcoind's legacy
 * of little-endian uint256s.
 * @param {Network} network
 * @param {Boolean} minimal
 * @returns {Object}
 */

Coin.prototype.getJSON = function getJSON(network, minimal) {
  var address = this.getAddress();

  network = Network.get(network);

  if (address)
    address = address.toBase58(network);

  return {
    version: this.version,
    height: this.height,
    value: Amount.btc(this.value),
    script: this.script.toJSON(),
    address: address,
    coinbase: this.coinbase,
    hash: !minimal
      ? (this.hash ? util.revHex(this.hash) : null)
      : undefined,
    index: !minimal ? this.index : undefined
  };
};

/**
 * Inject JSON properties into coin.
 * @private
 * @param {Object} json
 */

Coin.prototype.fromJSON = function fromJSON(json) {
  assert(json, 'Coin data required.');
  assert(util.isNumber(json.version));
  assert(util.isNumber(json.height));
  assert(typeof json.value === 'string');
  assert(typeof json.coinbase === 'boolean');
  assert(!json.hash || typeof json.hash === 'string');
  assert(!json.index || util.isNumber(json.index));

  this.version = json.version;
  this.height = json.height;
  this.value = Amount.value(json.value);
  this.script.fromJSON(json.script);
  this.coinbase = json.coinbase;
  this.hash = json.hash ? util.revHex(json.hash) : null;
  this.index = json.index != null ? json.index : -1;

  return this;
};

/**
 * Instantiate an Coin from a jsonified coin object.
 * @param {Object} json - The jsonified coin object.
 * @returns {Coin}
 */

Coin.fromJSON = function fromJSON(json) {
  return new Coin().fromJSON(json);
};

/**
 * Calculate size of coin.
 * @returns {Number}
 */

Coin.prototype.getSize = function getSize() {
  return 17 + this.script.getVarSize();
};

/**
 * Write the coin to a buffer writer.
 * @param {BufferWriter} bw
 */

Coin.prototype.toWriter = function toWriter(bw) {
  var height = this.height;

  if (height === -1)
    height = 0x7fffffff;

  bw.writeU32(this.version);
  bw.writeU32(height);
  bw.write64(this.value);
  bw.writeVarBytes(this.script.toRaw());
  bw.writeU8(this.coinbase ? 1 : 0);

  return bw;
};

/**
 * Serialize the coin.
 * @returns {Buffer|String}
 */

Coin.prototype.toRaw = function toRaw() {
  var size = this.getSize();
  return this.toWriter(new StaticWriter(size)).render();
};

/**
 * Inject properties from serialized buffer writer.
 * @private
 * @param {BufferReader} br
 */

Coin.prototype.fromReader = function fromReader(br) {
  this.version = br.readU32();
  this.height = br.readU32();
  this.value = br.read64();
  this.script.fromRaw(br.readVarBytes());
  this.coinbase = br.readU8() === 1;

  if (this.height === 0x7fffffff)
    this.height = -1;

  return this;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 */

Coin.prototype.fromRaw = function fromRaw(data) {
  return this.fromReader(new BufferReader(data));
};

/**
 * Instantiate a coin from a buffer reader.
 * @param {BufferReader} br
 * @returns {Coin}
 */

Coin.fromReader = function fromReader(br) {
  return new Coin().fromReader(br);
};

/**
 * Instantiate a coin from a serialized Buffer.
 * @param {Buffer} data
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Coin}
 */

Coin.fromRaw = function fromRaw(data, enc) {
  if (typeof data === 'string')
    data = new Buffer(data, enc);
  return new Coin().fromRaw(data);
};

/**
 * Inject properties from TX.
 * @param {TX} tx
 * @param {Number} index
 */

Coin.prototype.fromTX = function fromTX(tx, index, height) {
  assert(util.isNumber(index));
  assert(index < tx.outputs.length);
  assert(typeof height === 'number');
  this.version = tx.version;
  this.height = height;
  this.value = tx.outputs[index].value;
  this.script = tx.outputs[index].script;
  this.coinbase = tx.isCoinbase();
  this.hash = tx.hash('hex');
  this.index = index;
  return this;
};

/**
 * Instantiate a coin from a TX
 * @param {TX} tx
 * @param {Number} index - Output index.
 * @returns {Coin}
 */

Coin.fromTX = function fromTX(tx, index, height) {
  return new Coin().fromTX(tx, index, height);
};

/**
 * Test an object to see if it is a Coin.
 * @param {Object} obj
 * @returns {Boolean}
 */

Coin.isCoin = function isCoin(obj) {
  return obj
    && obj.version !== undefined
    && obj.script !== undefined
    && typeof obj.getDepth === 'function';
};

/*
 * Expose
 */

module.exports = Coin;
