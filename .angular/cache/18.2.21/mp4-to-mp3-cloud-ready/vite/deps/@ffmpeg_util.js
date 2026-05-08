import {
  __async
} from "./chunk-5K356HEJ.js";

// node_modules/@ffmpeg/util/dist/esm/errors.js
var ERROR_RESPONSE_BODY_READER = new Error("failed to get response body reader");
var ERROR_INCOMPLETED_DOWNLOAD = new Error("failed to complete download");

// node_modules/@ffmpeg/util/dist/esm/const.js
var HeaderContentLength = "Content-Length";

// node_modules/@ffmpeg/util/dist/esm/index.js
var readFromBlobOrFile = (blob) => new Promise((resolve, reject) => {
  const fileReader = new FileReader();
  fileReader.onload = () => {
    const {
      result
    } = fileReader;
    if (result instanceof ArrayBuffer) {
      resolve(new Uint8Array(result));
    } else {
      resolve(new Uint8Array());
    }
  };
  fileReader.onerror = (event) => {
    reject(Error(`File could not be read! Code=${event?.target?.error?.code || -1}`));
  };
  fileReader.readAsArrayBuffer(blob);
});
var fetchFile = (file) => __async(void 0, null, function* () {
  let data;
  if (typeof file === "string") {
    if (/data:_data\/([a-zA-Z]*);base64,([^"]*)/.test(file)) {
      data = atob(file.split(",")[1]).split("").map((c) => c.charCodeAt(0));
    } else {
      data = yield (yield fetch(file)).arrayBuffer();
    }
  } else if (file instanceof URL) {
    data = yield (yield fetch(file)).arrayBuffer();
  } else if (file instanceof File || file instanceof Blob) {
    data = yield readFromBlobOrFile(file);
  } else {
    return new Uint8Array();
  }
  return new Uint8Array(data);
});
var importScript = (url) => __async(void 0, null, function* () {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    const eventHandler = () => {
      script.removeEventListener("load", eventHandler);
      resolve();
    };
    script.src = url;
    script.type = "text/javascript";
    script.addEventListener("load", eventHandler);
    document.getElementsByTagName("head")[0].appendChild(script);
  });
});
var downloadWithProgress = (url, cb) => __async(void 0, null, function* () {
  const resp = yield fetch(url);
  let buf;
  try {
    const total = parseInt(resp.headers.get(HeaderContentLength) || "-1");
    const reader = resp.body?.getReader();
    if (!reader) throw ERROR_RESPONSE_BODY_READER;
    const chunks = [];
    let received = 0;
    for (; ; ) {
      const {
        done,
        value
      } = yield reader.read();
      const delta = value ? value.length : 0;
      if (done) {
        if (total != -1 && total !== received) throw ERROR_INCOMPLETED_DOWNLOAD;
        cb && cb({
          url,
          total,
          received,
          delta,
          done
        });
        break;
      }
      chunks.push(value);
      received += delta;
      cb && cb({
        url,
        total,
        received,
        delta,
        done
      });
    }
    const data = new Uint8Array(received);
    let position = 0;
    for (const chunk of chunks) {
      data.set(chunk, position);
      position += chunk.length;
    }
    buf = data.buffer;
  } catch (e) {
    console.log(`failed to send download progress event: `, e);
    buf = yield resp.arrayBuffer();
    cb && cb({
      url,
      total: buf.byteLength,
      received: buf.byteLength,
      delta: 0,
      done: true
    });
  }
  return buf;
});
var toBlobURL = (url, mimeType, progress = false, cb) => __async(void 0, null, function* () {
  const buf = progress ? yield downloadWithProgress(url, cb) : yield (yield fetch(url)).arrayBuffer();
  const blob = new Blob([buf], {
    type: mimeType
  });
  return URL.createObjectURL(blob);
});
export {
  downloadWithProgress,
  fetchFile,
  importScript,
  toBlobURL
};
//# sourceMappingURL=@ffmpeg_util.js.map
