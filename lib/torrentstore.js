module.exports = TorrentStore

/* global indexedDB */

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var IdbKvStore = require('idb-kv-store')
var IdbChunkStore = require('indexeddb-chunk-store')

inherits(TorrentStore, EventEmitter)
function TorrentStore (namespace) {
  EventEmitter.call(this)
  var self = this
  self._namespace = namespace
  self._store = new IdbKvStore(namespace + '-torrents')

  self._store.on('set', function (change) {
    self.emit('add', change.value)
  })
}

TorrentStore.prototype.add = function (infoHash, rawTorrent, cb) {
  if (!this._store) throw new Error('Database is closed')
  this._store.set(infoHash, rawTorrent, cb)
}

TorrentStore.prototype.remove = function (infoHash, cb) {
  if (!this._store) throw new Error('Database is closed')
  this._store.remove(infoHash, cb)
}

TorrentStore.prototype.getAll = function (cb) {
  if (!this._store) throw new Error('Database is closed')
  this._store.values(cb)
}

TorrentStore.prototype.updateMeta = function (infoHash, torrentMetaBuffer, cb) {
  var self = this
  if (!self._store) throw new Error('Database is closed')
  var transaction = self._store.transaction()
  transaction.get(infoHash, function (err, rawTorrent) {
    if (err) return cb(err)
    if (!rawTorrent) cb(new Error('Torrent does not exist'))

    rawTorrent.torrentMetaBuffer = torrentMetaBuffer
    transaction.set(infoHash, rawTorrent, function (err) {
      if (err) {
        if (cb) cb(err)
      } else {
        self.emit('add', rawTorrent)
        if (cb) cb(null)
      }
    })
  })
}

TorrentStore.prototype.connectTorrentDB = function (infoHash) {
  return new TorrentDB(this, this._namespace, infoHash)
}

TorrentStore.prototype.close = function () {
  if (!this._store) return
  this._store.close()
  this._store = null
}

inherits(TorrentDB, EventEmitter)
function TorrentDB (torrentStore, namespace, infoHash) {
  var self = this
  EventEmitter.call(self)
  self._torrentStore = torrentStore
  self._infoHash = infoHash
  self._priorityDbName = namespace + '-priority-' + infoHash
  self._chunkStoreDbName = namespace + '-data-' + self.infoHash
  self._priority = new IdbKvStore(self._priorityDbName) // TODO lazily initiaize resources
  self._priority.on('add', onPriority)

  function onPriority (change) {
    self.emit('priority', change.value)
  }
}

TorrentDB.prototype.updateMeta = function (torrentMetaBuffer, cb) {
  this._torrentStore.updateMeta(this._infoHash, torrentMetaBuffer, cb)
}

TorrentDB.prototype.getPriorities = function (cb) {
  this._priority.values(cb)
}

TorrentDB.prototype.addPriority = function (start, end, cb) {
  var p = { start: start, end: end }
  this._priority.add(p, cb) // TODO only add if necessary
  this.emit('priority', p) // onPriority is not called for local mutations
}

TorrentDB.prototype.removeAllPriorities = function (cb) {
  this._priority.clear(cb)
}

TorrentDB.prototype.createChunkStore = function (chunkLength, opts) {
  var custom = {} // Good practice to treat `opts` as read only so copy into `custom`
  for (var k in opts) custom[k] = opts[k]
  custom.name = this._chunkStoreDbName
  delete custom.torrent // TODO fix this in indexeddb-chunk-store
  return new IdbChunkStore(chunkLength, custom)
}

TorrentDB.prototype.close = function () {
  if (!this._priority) return
  this._priority.close()
  this._priority = null
}

TorrentDB.prototype.destroy = function () {
  this.close()
  indexedDB.deleteDatabase(this._priorityDbName)
  indexedDB.deleteDatabase(this._chunkStoreDbName)
}