
var preCached = [
  '/planktos/root.torrent',
  '/planktos/manifest.json',
  '/planktos/injection.html',
  '/planktos/injection.bundle.js',
  '/planktos/install.js'
]

module.exports.getFileBlob = getFileBlob
module.exports.update = update
module.exports.preCached = preCached
module.exports.getManifest = getManifest
module.exports.getDownloaded = getDownloaded
module.exports.getTorrentMeta = getTorrentMeta
module.exports.getTorrentMetaBuffer = getTorrentMetaBuffer

var ChunkStream = require('chunk-store-stream')
var IdbChunkStore = require('indexdb-chunk-store')
var IdbKvStore = require('idb-kv-store')
var toBlob = require('stream-to-blob')
var parseTorrent = require('parse-torrent-file')

var global = typeof window !== 'undefined' ? window : self // eslint-disable-line
var waitingFetches = {}
var persistent = new IdbKvStore('planktos')
var downloaded = new IdbKvStore('planktos-downloaded')
var chunkStore = null
var downloadChannel = new BroadcastChannel('planktos')
downloadChannel.addEventListener('message', onDownload)

function getDownloaded () {
  return downloaded.json()
}

function getManifest () {
  return persistent.get('torrentMeta')
}

function getTorrentMeta () {
  return persistent.get('torrentMeta')
}

function getTorrentMetaBuffer () {
  return persistent.get('torrentMetaBuffer')
}

function getFileBlob (filename) {
  return persistent.get(['manifest', 'torrentMeta']).then(result => {
    var [manifest, torrentMeta] = result
    var hash = manifest[filename]
    var fileInfo = torrentMeta.files.find(f => f.name === hash)

    if (!fileInfo) {
      return Promise.resolve(null) // TODO actually reject promise
    }

    chunkStore = chunkStore || new IdbChunkStore(torrentMeta.pieceLength, {name: torrentMeta.infoHash})

    return downloaded.get(hash).then(isDownloaded => {
      if (isDownloaded) {
        var stream = ChunkStream.read(chunkStore, chunkStore.chunkLength, {
          length: torrentMeta.length
        })
        return new Promise(function (resolve, reject) {
          toBlob(stream, function (err, blob) {
            if (err) return reject(err)
            resolve(blob.slice(fileInfo.offset, fileInfo.offset + fileInfo.length))
          })
        })
      } else {
        // Defer until the file finishes downloading
        return new Promise(function (resolve) {
          if (!waitingFetches[hash]) waitingFetches[hash] = []
          waitingFetches[hash].push(resolve)
        })
      }
    })
  })
}

function update () {
  var cachePromise = global.caches.open('planktos')
  .then((cache) => cache.addAll(preCached))

  var manifestPromise = global.fetch('/planktos/manifest.json') // TODO use cache
  .then(response => response.json())
  .then(json => {
    return persistent.set('manifest', json)
  })

  var torrentPromise = global.fetch('/planktos/root.torrent') // TODO use cache
  .then(response => response.arrayBuffer())
  .then(arrayBuffer => {
    var buffer = Buffer.from(arrayBuffer)
    var parsed = parseTorrent(buffer)
    return Promise.all([
      persistent.set('torrentMetaBuffer', buffer),
      persistent.set('torrentMeta', parsed)
    ])
  })

  var downloadedPromise = persistent.get('downloaded')
  .then(downloaded => {
    if (!downloaded) return persistent.set('downloaded', {})
  })

  return Promise.all([
    cachePromise,
    manifestPromise,
    torrentPromise,
    downloadedPromise
  ])
}

function onDownload () {
  return Promise.all([
    persistent.get('manifest'),
    downloaded.json()
  ]).then(result => {
    var [manifest, downloaded] = result
    for (var hash in downloaded) {
      if (hash in waitingFetches) {
        var filename = Object.keys(manifest).find(fname => manifest[fname] === hash)
        var waiters = waitingFetches[hash]
        delete waitingFetches[hash]
        getFileBlob(filename)
        .then(b => {
          for (var p of waiters) {
            p(b)
          }
        })
      }
    }
  })
}