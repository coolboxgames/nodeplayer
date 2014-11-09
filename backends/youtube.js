var config;
var creds = require(process.env.HOME + '/.youtubeCreds.json');
var mkdirp = require('mkdirp');
var https = require('https');
var querystring = require('querystring');
var send = require('send');
var url = require('url');
var fs = require('fs');
var ytdl = require('ytdl-core');
var ffmpeg = require('fluent-ffmpeg');

var youtubeBackend = {};
var musicCategoryId = '';

var youtubeDownload = function(songID, callback, errCallback) {
    var filePath = config.songCachePath + '/youtube/' + songID + '.ogg';

    var stream = ytdl('http://www.youtube.com/watch?v=' + songID)
    ffmpeg(stream)
    .noVideo()
    .audioCodec('libvorbis')
    .audioBitrate('320k')
    .on('end', function() {
        console.log('successfully transcoded ' + songID);
        callback();
    })
    .on('error', function(err) {
        errCallback('youtube: error while transcoding ' + songID + ': ' + err);
    })
    .save(filePath);
    console.log('transcoding ' + songID + '...');
};

var pendingSongs = {};
// cache songID to disk.
// on success: callback must be called
// on failure: errCallback must be called with error message
youtubeBackend.prepareSong = function(songID, callback, errCallback) {
    var filePath = config.songCachePath + '/youtube/' + songID + '.ogg';

    // song is already downloading
    if(pendingSongs[songID]) {
        return;
    }

    if(fs.existsSync(filePath)) {
        // song was found from cache
        if(callback)
            callback();
        return;
    } else {
        // song had to be downloaded
        pendingSongs[songID] = true;
        youtubeDownload(songID, function() {
            delete(pendingSongs[songID]);
            callback();
        }, function(err) {
            delete(pendingSongs[songID]);
            errCallback(err);
        });
    }
};

// WTF youtube
// http://stackoverflow.com/questions/22148885/converting-youtube-data-api-v3-video-duration-format-to-seconds-in-javascript-no
var ytDurationToMillis = function(ytDuration) {
    var matches = ytDuration.match(/[0-9]+[HMS]/g);
    var seconds = 0;

    matches.forEach(function (part) {
        var unit = part.charAt(part.length - 1);
        var amount = parseInt(part.slice(0, -1));

        switch (unit) {
            case 'H':
                seconds += amount * 60 * 60;
                break;
            case 'M':
                seconds += amount * 60;
                break;
            case 'S':
                seconds += amount;
                break;
            default:
                // noop
        }
    });

    return seconds * 1000;
};

var getSongDurations = function(ids, callback) {
    var url = 'https://www.googleapis.com/youtube/v3/videos?'
            + 'id=' + ids.join(',')
            + '&'
            + querystring.stringify({
                'part': 'contentDetails',
                'key': creds.apiKey
            });

    var jsonData = "";

    var req = https.request(url, function(res) {
        res.on('data', function(chunk) {
            jsonData += chunk.toString('utf8');
            //fs.writeSync(songFd, chunk, 0, chunk.length, null);
        });
        res.on('end', function() {
            var durations = {};

            jsonData = JSON.parse(jsonData);
            if(jsonData) {
                for(var i = 0; i < jsonData.items.length; i++) {
                    durations[jsonData.items[i].id] =
                        ytDurationToMillis(jsonData.items[i].contentDetails.duration);
                }
                callback(durations);
            } else {
                errCallback("youtube: unexpected error while fetching metadata");
            }
        });
    });
    req.end();
};

// search for music from the backend
// on success: callback must be called with a list of song objects
// on failure: errCallback must be called with error message
youtubeBackend.search = function(terms, callback, errCallback) {
    var jsonData = "";
    var url = 'https://www.googleapis.com/youtube/v3/search?'
            + querystring.stringify({
                'q': terms,
                'type': 'video',
                'part': 'snippet',
                'maxResults': config.searchResultCnt + 1,
                'regionCode': 'FI', // TODO: put this into a youtube specific config file
                'key': creds.apiKey
            });
    var req = https.request(url, function(res) {
        res.on('data', function(chunk) {
            jsonData += chunk.toString('utf8');
            //fs.writeSync(songFd, chunk, 0, chunk.length, null);
        });
        res.on('end', function() {
            jsonData = JSON.parse(jsonData);
            var songs = [];
            var ids = [];
            if(jsonData.items) {
                for(var i = 0; i < jsonData.items.length; i++) {
                    ids.push(jsonData.items[i].id.videoId);
                }

                getSongDurations(ids, function(durations) {
                    for(var i = 0; i < jsonData.items.length; i++) {
                        var splitTitle = jsonData.items[i].snippet.title.split(/\s-\s(.+)?/);
                        songs[i] = {
                            artist: splitTitle[0],
                            title: splitTitle[1],
                            album: null,
                            albumArt: jsonData.items[i].snippet.thumbnails.default,
                            duration: durations[jsonData.items[i].id.videoId],
                            id: jsonData.items[i].id.videoId,
                            backend: 'youtube',
                            format: 'ogg'
                        };
                    }
                    callback(songs);
                }, function(err) {
                    errCallback(err);
                });
            } else {
                errCallback("youtube: no results found");
            }
        });
    });
    req.end();
};

// called when partyplay is started to initialize the backend
// do any necessary initialization here
youtubeBackend.init = function(_config, callback, errCallback) {
    config = _config;
    mkdirp(config.songCachePath + '/youtube');

    // find the category id for music videos
    var jsonData = "";
    var url = 'https://www.googleapis.com/youtube/v3/videoCategories?'
            + querystring.stringify({
                'part': 'snippet',
                'regionCode': 'FI', // TODO: put this into a youtube specific config file
                'key': creds.apiKey
            });
    var req = https.request(url, function(res) {
        res.on('data', function(chunk) {
            jsonData += chunk.toString('utf8');
            //fs.writeSync(songFd, chunk, 0, chunk.length, null);
        });
        res.on('end', function() {
            jsonData = JSON.parse(jsonData);
            for(var i = 0; i < jsonData.items.length; i++) {
                if(jsonData.items[i].snippet.title === 'Music') {
                    musicCategoryId = jsonData.items[i].id;
                    callback();
                    break;
                }
            }
            if(musicCategoryId === '') {
                errCallback('category for music not supported in your country!');
            }
        });
    });
    req.end();
};

// expressjs middleware for requesting music data
// must support ranges in the req, and send the data to res
youtubeBackend.middleware = function(req, res, next) {
    send(req, url.parse(req.url).pathname, {
        dotfiles: 'allow',
        root: config.songCachePath + '/youtube'
    }).pipe(res);
};

module.exports = youtubeBackend;
