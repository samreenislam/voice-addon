'use strict';

const {APIHandler, APIResponse} = require('gateway-addon');
const manifest = require('./manifest.json');
const path = require('path');
const fs = require('fs');
const matrix = require("@matrix-io/matrix-lite");
const cp = require('child_process');
const webSocket = require('ws');
const EventEmitter = require('events');

class DSAPIHandler extends APIHandler {
  constructor(addonManager) {
    super(addonManager, manifest.id);
    addonManager.addAPIHandler(this);
    this.events = new EventEmitter();
    this._wsPort = 3000;
    this._dsWorker = null;
    this.setup().then(() => {
      console.log('Waiting 5 secs to setup things ...');
      setTimeout(() => {
        this._dsWorker = cp.fork(`${__dirname}/deepspeech.js`, [ this._modelsDir, this._wsPort ]);
        this._dsWorker.on('close', (code, signal) => {
          console.log(`child process terminated due to receipt of signal ${signal} with exit code ${code}`);
        });
      }, 5*1000);
    });
  }

  async setup() {
    const modelsDir = path.join(this.userProfile.dataDir, manifest.id, 'models');
    console.log('Checking existence of models under ' + modelsDir);

    this._modelsDir = modelsDir;

    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir);
      await this.downloadModel(modelsDir);
    }
  }

  async downloadModel(rootDir) {
    const fetch = require('node-fetch');
    const unzip = require('unzipper');

    const kTflite = 'output_graph.tflite';
    const kInfos  = 'info.json';

    const kModelURL = 'https://github.com/lissyx/DeepSpeech/releases/download/v0.6.0/en-us.zip';
    const kModelDir = path.join(rootDir, 'en-us');
    const kModelFile = path.join(kModelDir, kTflite);
    const kModelZip = path.join(kModelDir, 'en-us.zip');

    if (fs.existsSync(kModelFile)) {
      console.log('Model file exists: ' + kModelFile);
      return;
    }

    console.log('Model file does not exists: ' + kModelFile);
    fs.mkdirSync(kModelDir);

    console.debug('fetching ' + kModelURL);
    const res = await fetch(kModelURL);
    await new Promise((resolve, reject) => {
      const fStream = fs.createWriteStream(kModelZip);
      console.debug('opening stream to ' + kModelZip);
      res.body.pipe(fStream);
      console.debug('writing stream to ' + kModelZip);
      res.body.on('error', (err) => {
        console.debug('download failure ' + err);
        reject(err);
      });
      console.debug('waiting stream to ' + kModelZip);
      fStream.on('finish', function() {
        console.debug('download success');
        let hasModel = false;
        let hasInfos = false;
        fs.createReadStream(kModelZip)
        .pipe(unzip.Parse())
        .on('entry', (entry) => {
          console.debug('archive entry: ' + entry.path);
          if (entry.path == kTflite || entry.path == kInfos) {
            entry.pipe(fs.createWriteStream(path.join(kModelDir, entry.path)))
            .on('finish', () => {
              console.debug('archive entry: ' + entry.path + ' finished');

              if (entry.path == kTflite) {
                hasModel = true;
              }

              if (entry.path == kInfos) {
                hasInfos = true;
              }

              console.debug('archive hasModel:' + hasModel + ' -- hasInfos:' + hasInfos);
              if (hasModel && hasInfos) {
                resolve();
              }
            });
          } else {
            entry.autodrain();
          }
        });
      });
    });

    console.debug('should run after finished stream to ' + kModelZip);
    fs.unlinkSync(kModelZip);
    console.debug('removed ' + kModelZip);
  }

  async generateLocalLM(devices) {
    console.log('Generate local LM for models under ' + this._modelsDir);

    /**
     * List of commands from src/controllers/commands_controller.js#L6-L13:
     *  Grammar that the parser understands:
     *  Turn the <tag> light <on|off>
     *  Turn <tag> <on|off>
     *  Shut <tag> <on|off>
     *  Shut the <tag> light <on|off>
     *  When was <tag> last <boolean>
     *  Is <tag> <boolean>
     *  Is <tag> not <boolean>
     **/

    let grammar = [
       'Turn the <tag> light <on|off>',
       'Turn <tag> <on|off>',
       'Shut <tag> <on|off>',
       'Shut the <tag> light <on|off>',
       'When was <tag> last <boolean>',
       'Is <tag> <boolean>',
       'Is <tag> not <boolean>',
    ];

    let finalGrammar = [];

    const on_off = ['on', 'off'];
    const true_false = ['true', 'false'];
    let tags = [];
    devices.forEach((device) => {
      tags.push(device.title);
    });
    console.log('Generate local LM for devices: ' + JSON.stringify(tags));

    for (let i = 0; i < grammar.length; i++) {
       tags.forEach((tag) => {
         let gi = grammar[i];
         gi = gi.replace(/<tag>/g, tag);

         let gii_on_off = gi;
         on_off.forEach((sw) => {
           gi = gii_on_off.replace(/<on\|off>/g, sw);

           let gii_true_false = gi;
           true_false.forEach((bool) => {
             gi = gii_true_false.replace(/<boolean>/g, bool).toLowerCase();

             if (finalGrammar.indexOf(gi) < 0) {
               // console.log('for ' + tag + ': ' + gi);
               finalGrammar.push(gi);
             }
           });

         });
       });
    }

    const localLMTxt    = path.join(this._modelsDir, 'en-us', 'local_lm.txt');
    const localLMArpa   = path.join(this._modelsDir, 'en-us', 'local_lm.arpa');
    const localLMBinary = path.join(this._modelsDir, 'en-us', 'local_lm.binary');
    fs.writeFileSync(localLMTxt, finalGrammar.join('\n'));

    const binDir = path.join(this.userProfile.baseDir, 'addons', manifest.id, 'bin');
    const { spawnSync} = require('child_process');

    const child_lmplz = spawnSync(path.join(binDir, 'lmplz'), [
        '--memory', '64M',
        '--order', '2', '--discount_fallback',
        '--text', localLMTxt,
        '--arpa', localLMArpa
    ]);

    console.log('lmplz error', child_lmplz.error);
    console.log('lmplz stdout ', child_lmplz.stdout.toString());
    console.log('lmplz stderr ', child_lmplz.stderr.toString());

    const child_binary = spawnSync(path.join(binDir, 'build_binary'), [
        '-a', '255', '-q', '8', 'trie',
        localLMArpa, localLMBinary
    ]);

    console.log('binary error', child_binary.error);
    console.log('binary stdout ', child_binary.stdout.toString());
    console.log('binary stderr ', child_binary.stderr.toString());
  }

  startMatrixMic() {
    console.log("About to start Matrix mic");

    this._ws = new webSocket('ws://127.0.0.1:' + this._wsPort + '/stream');

    this._ws.on('message', (m) => {
      const msg = JSON.parse(m);
      console.log("Received message: " + m);

      if (msg['sampleRate']) {
        const modelSampleRate = msg['sampleRate'];
        console.log('Setting sample rate to: ' + modelSampleRate);
        this._mic = matrix.alsa.mic({ // or configure settings
          endian: 'little',
          encoding: 'signed-integer',
          device: 'plughw:CARD=MATRIXIOSOUND,DEV=0',
          bitwidth: 16,
          rate: modelSampleRate,
          debug: false,
          exitOnSilence: 96, // in frames
          // up to 8 channels
          channels: 1
        });

        // Pipe mic data to file
        var micStream = this._mic.getAudioStream();
        micStream.pipe(webSocket.createWebSocketStream(this._ws));

        micStream.on('silence', () => {
          console.log("Got SIGNAL silence");
          this.stopMatrixMic();
          this.events.emit('silence', {});
        });

        this._mic.start();
        console.log("Matrix mic started");
      }

      if (msg['transcript']) {
        console.log('Computed transcript was: ' + msg['transcript']);
        this.events.emit('transcript', msg);
      }
    });

    this._ws.on('open', () => {
      this._ws.send('sample-rate');
    });
  }

  stopMatrixMic() {
    console.log("About to stop Matrix mic");
    this._mic && this._mic.stop();
    this._ws && this._ws.send("end");
    console.log("Matrix mic stopped");
  }

  async handleRequest(request) {
    console.log('request.method=' + request.method + " -- request.path=" + request.path);
    if (request.method === 'POST' && request.path === '/micControl') {
      console.log('request.body=' + JSON.stringify(request.body));
      if (request.body["status"] === true) {
        this.startMatrixMic();
      } else {
        this.stopMatrixMic();
      }

      const newStatus = request.body["status"] ? 'recording' : 'stopped';
      return new APIResponse({
        status: 200,
        contentType: 'application/json',
        content: JSON.stringify({'status': newStatus}),
      });
    }

    return new APIResponse({
      status: 200,
      contentType: 'application/json',
      content: JSON.stringify({'error': 'use websocket'}),
    });
  }
}

module.exports = DSAPIHandler;
