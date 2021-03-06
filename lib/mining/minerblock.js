/*!
 * minerblock.js - miner block object for bcoin (because we can)
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var assert = require('assert');
var util = require('../utils/util');
var btcutils = require('../btc/utils');
var co = require('../utils/co');
var StaticWriter = require('../utils/staticwriter');
var constants = require('../protocol/constants');
var Network = require('../protocol/network');
var BN = require('bn.js');
var EventEmitter = require('events').EventEmitter;
var TX = require('../primitives/tx');
var Block = require('../primitives/block');
var Input = require('../primitives/input');
var Output = require('../primitives/output');
var mine = require('./mine');
var workerPool = require('../workers/workerpool').pool;

/**
 * MinerBlock
 * @exports MinerBlock
 * @constructor
 * @param {Object} options
 * @param {ChainEntry} options.tip
 * @param {Number} options.height
 * @param {Number} options.target - Compact form.
 * @param {Base58Address} options.address - Payout address.
 * @param {Boolean} options.witness - Allow witness
 * transactions, mine a witness block.
 * @param {String} options.coinbaseFlags
 * @property {Block} block
 * @property {TX} coinbase
 * @property {BN} hashes - Number of hashes attempted.
 * @property {Number} rate - Hash rate.
 * @emits MinerBlock#status
 */

function MinerBlock(options) {
  if (!(this instanceof MinerBlock))
    return new MinerBlock(options);

  EventEmitter.call(this);

  this.tip = options.tip;
  this.version = options.version;
  this.height = options.tip.height + 1;
  this.bits = options.bits;
  this.target = btcutils.fromCompact(this.bits).toArrayLike(Buffer, 'le', 32);
  this.locktime = options.locktime;
  this.flags = options.flags;
  this.nonce1 = 0;
  this.nonce2 = 0;
  this.iterations = 0;
  this.coinbaseFlags = options.coinbaseFlags;
  this.witness = options.witness;
  this.address = options.address;
  this.network = Network.get(options.network);
  this.reward = btcutils.getReward(this.height, this.network.halvingInterval);

  this.destroyed = false;
  this.committed = false;

  this.sigops = 0;
  this.weight = 0;
  this.fees = 0;
  this.items = [];

  this.coinbase = new TX();
  this.coinbase.mutable = true;

  this.block = new Block();
  this.block.mutable = true;

  this._init();
}

util.inherits(MinerBlock, EventEmitter);

/**
 * Nonce range interval.
 * @const {Number}
 * @default
 */

MinerBlock.INTERVAL = 0xffffffff / 1500 | 0;

/**
 * Calculate number of hashes.
 * @returns {Number}
 */

MinerBlock.prototype.getHashes = function() {
  return this.iterations * 0xffffffff + this.block.nonce;
};

/**
 * Calculate hashrate.
 * @returns {Number}
 */

MinerBlock.prototype.getRate = function() {
  return (this.block.nonce / (util.now() - this.begin)) | 0;
};

/**
 * Initialize the block.
 * @private
 */

MinerBlock.prototype._init = function _init() {
  var scale = constants.WITNESS_SCALE_FACTOR;
  var block = this.block;
  var cb = this.coinbase;
  var input, output, nonce;

  // Setup our block.
  block.version = this.version;
  block.prevBlock = this.tip.hash;
  block.merkleRoot = constants.NULL_HASH;
  block.ts = Math.max(this.network.now(), this.tip.ts + 1);
  block.bits = this.bits;
  block.nonce = 0;

  // Coinbase input.
  input = new Input();

  // Height (required in v2+ blocks)
  input.script.set(0, new BN(this.height));

  // Let the world know this little
  // miner succeeded.
  input.script.set(1, this.coinbaseFlags);

  input.script.set(2, util.nonce().slice(0, 4));

  // extraNonce - incremented when
  // the nonce overflows.
  input.script.set(3, this.extraNonce());

  input.script.compile();

  cb.inputs.push(input);

  // Reward output.
  output = new Output();
  output.script.fromAddress(this.address);

  cb.outputs.push(output);

  // If we're using segwit, we need to
  // set up the nonce and commitment.
  if (this.witness) {
    // Our witness nonce is the hash256
    // of the previous block hash.
    nonce = block.createWitnessNonce();

    // Set up the witness nonce.
    input.witness.set(0, nonce);
    input.witness.compile();

    // Commitment output.
    cb.outputs.push(new Output());
  }

  block.txs.push(cb);

  // Update coinbase since our coinbase was added.
  this.updateCoinbase();

  // Create our merkle root.
  this.updateMerkle();

  // Initialize weight.
  this.weight = this.block.getWeight();

  // 4 extra bytes for varint tx count.
  this.weight += 4 * scale;

  // 8 extra bytes for extra nonce.
  this.weight += 8 * scale;

  // Initialize sigops weight.
  this.sigops = cb.getSigopsCost(null, this.flags);
};

/**
 * Update the commitment output for segwit.
 */

MinerBlock.prototype.updateCommitment = function updateCommitment() {
  var output = this.coinbase.outputs[1];
  var flags = this.coinbaseFlags;
  var hash;

  // Recalculate witness merkle root.
  hash = this.block.createCommitmentHash();

  // Update commitment.
  output.script.clear();
  output.script.fromCommitment(hash, flags);
};

/**
 * Update the extra nonce and coinbase reward.
 */

MinerBlock.prototype.updateCoinbase = function updateCoinbase() {
  var input = this.coinbase.inputs[0];
  var output = this.coinbase.outputs[0];

  // Update extra nonce.
  input.script.set(3, this.extraNonce());
  input.script.compile();

  // Update reward.
  output.value = this.reward + this.fees;
};

/**
 * Increment the extraNonce.
 */

MinerBlock.prototype.updateNonce = function updateNonce() {
  this.block.ts = Math.max(this.network.now(), this.tip.ts + 1);

  // Overflow the nonce and increment the extraNonce.
  this.block.nonce = 0;

  this.nonce1++;
  this.nonce1 &= 0xffffffffffff;

  if (this.nonce1 === 0)
    this.nonce2++;

  // We incremented the extraNonce, need to update coinbase.
  this.updateCoinbase();

  // We changed the coinbase, need to update merkleRoot.
  this.updateMerkle();
};

/**
 * Rebuild the merkle tree and update merkle root as well as the
 * timestamp (also calls {@link MinerBlock#updateCommitment}
 * if segwit is enabled).
 */

MinerBlock.prototype.updateMerkle = function updateMerkle() {
  // Always update commitment before updating merkle root.
  // The updated commitment output will change the merkle root.
  if (this.witness)
    this.updateCommitment();

  // Update timestamp.
  this.block.ts = Math.max(this.network.now(), this.tip.ts + 1);

  // Recalculate merkle root.
  this.block.merkleRoot = this.block.createMerkleRoot('hex');
};

/**
 * Render extraNonce.
 * @returns {Buffer}
 */

MinerBlock.prototype.extraNonce = function extraNonce() {
  var bw = new StaticWriter(12);
  bw.writeU32BE(this.nonce1 / 0x10000 | 0);
  bw.writeU16BE(this.nonce1 & 0xffff);
  bw.writeU32BE(this.nonce2 / 0x10000 | 0);
  bw.writeU16BE(this.nonce2 & 0xffff);
  return bw.render();
};

/**
 * Add a transaction to the block. Rebuilds the merkle tree,
 * updates coinbase and commitment.
 * @param {TX} tx
 * @returns {Boolean} Whether the transaction was successfully added.
 */

MinerBlock.prototype.addTX = function addTX(tx, view) {
  var item, weight, sigops;

  assert(!tx.mutable, 'Cannot add mutable TX to block.');

  if (this.block.hasTX(tx))
    return false;

  item = BlockEntry.fromTX(tx, view, this);
  weight = item.tx.getWeight();
  sigops = item.sigops;

  if (!tx.isFinal(this.height, this.locktime))
    return false;

  if (this.weight + weight > constants.block.MAX_WEIGHT)
    return false;

  if (this.sigops + sigops > constants.block.MAX_SIGOPS_COST)
    return false;

  if (!this.witness && tx.hasWitness())
    return false;

  this.weight += weight;
  this.sigops += sigops;
  this.fees += item.fee;

  // Add the tx to our block
  this.block.txs.push(tx);
  this.items.push(item);

  // Update coinbase value
  this.updateCoinbase();

  // Update merkle root for new coinbase and new tx
  this.updateMerkle();

  return true;
};

/**
 * Hash until the nonce overflows.
 * @returns {Boolean} Whether the nonce was found.
 */

MinerBlock.prototype.findNonce = function findNonce() {
  var block = this.block;
  var target = this.target;
  var data = block.abbr();
  var interval = MinerBlock.INTERVAL;
  var min = 0;
  var max = interval;
  var nonce;

  while (max <= 0xffffffff) {
    nonce = mine(data, target, min, max);

    if (nonce !== -1)
      break;

    block.nonce = max;

    min += interval;
    max += interval;

    this.sendStatus();
  }

  return nonce;
};

/**
 * Hash until the nonce overflows.
 * @returns {Boolean} Whether the nonce was found.
 */

MinerBlock.prototype.findNonceAsync = co(function* findNonceAsync() {
  var block = this.block;
  var target = this.target;
  var interval = MinerBlock.INTERVAL;
  var min = 0;
  var max = interval;
  var data, nonce;

  while (max <= 0xffffffff) {
    data = block.abbr();
    nonce = yield workerPool.mine(data, target, min, max);

    if (nonce !== -1)
      break;

    if (this.destroyed)
      return nonce;

    block.nonce = max;

    min += interval;
    max += interval;

    this.sendStatus();
  }

  return nonce;
});

/**
 * Mine synchronously until the block is found.
 * @returns {Block}
 */

MinerBlock.prototype.mine = function mine() {
  var nonce;

  // Track how long we've been at it.
  this.begin = util.now();

  assert(this.block.ts > this.tip.ts);

  for (;;) {
    nonce = this.findNonce();

    if (nonce !== -1)
      break;

    this.iterate();
  }

  this.commit(nonce);

  return this.block;
};

/**
 * Mine asynchronously until the block is found.
 * @returns {Promise} - Returns {@link Block}.
 */

MinerBlock.prototype.mineAsync = co(function* mineAsync() {
  var nonce;

  // Track how long we've been at it.
  this.begin = util.now();

  assert(this.block.ts > this.tip.ts);

  for (;;) {
    nonce = yield this.findNonceAsync();

    if (nonce !== -1)
      break;

    if (this.destroyed)
      return;

    this.iterate();
  }

  this.commit(nonce);

  return this.block;
});

/**
 * Increment extraNonce, rebuild merkletree.
 */

MinerBlock.prototype.iterate = function iterate() {
  var block = this.block;
  var tip = this.tip;
  var now = this.network.now();

  // Keep track of our iterations.
  this.iterations++;

  // Send progress report.
  this.sendStatus();

  // If we took more a second or more (likely),
  // skip incrementing the extra nonce and just
  // update the timestamp. This improves
  // performance because we do not have to
  // recalculate the merkle root.
  if (now > block.ts && now > tip.ts) {
    block.ts = now;
    // Overflow the nonce
    block.nonce = 0;
    return;
  }

  // Overflow the nonce and increment the extraNonce.
  this.updateNonce();
};

/**
 * Commit and finalize mined block.
 * @returns {Block}
 */

MinerBlock.prototype.commit = function commit(nonce) {
  assert(!this.committed, 'Block is already committed.');
  this.committed = true;
  this.block.nonce = nonce;
  this.block.mutable = false;
  this.coinbase.mutable = false;
  return this.block;
};

/**
 * Send a progress report (emits `status`).
 */

MinerBlock.prototype.sendStatus = function sendStatus() {
  this.emit('status', {
    block: this.block,
    target: this.block.bits,
    hashes: this.getHashes(),
    hashrate: this.getRate(),
    height: this.height,
    best: util.revHex(this.tip.hash)
  });
};

/**
 * Destroy the minerblock. Stop mining.
 */

MinerBlock.prototype.destroy = function destroy() {
  this.destroyed = true;
};

/**
 * BlockEntry
 * @constructor
 */

function BlockEntry(tx) {
  this.tx = tx;
  this.hash = tx.hash('hex');
  this.fee = 0;
  this.rate = 0;
  this.priority = 0;
  this.free = false;
  this.sigops = 0;
  this.depCount = 0;
}

BlockEntry.fromTX = function fromTX(tx, view, attempt) {
  var entry = new BlockEntry(tx);
  entry.fee = tx.getFee(view);
  entry.rate = tx.getRate(view);
  entry.priority = tx.getPriority(view, attempt.height);
  entry.free = false;
  entry.sigops = tx.getSigopsCost(view, attempt.flags);
  return entry;
};

BlockEntry.fromEntry = function fromEntry(entry, attempt) {
  var item = new BlockEntry(entry.tx);
  item.fee = entry.getFee();
  item.rate = entry.getRate();
  item.priority = entry.getPriority(attempt.height);
  item.free = entry.isFree(attempt.height);
  item.sigops = entry.sigops;
  return item;
};

/*
 * Expose
 */

exports = MinerBlock;
exports.MinerBlock = MinerBlock;
exports.BlockEntry = BlockEntry;

module.exports = exports;
