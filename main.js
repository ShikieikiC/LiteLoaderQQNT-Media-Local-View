const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const exec = require("child_process").exec;
const { shell, dialog, ipcMain, app } = require("electron");

var configFilePath = "";
var pipePath = null;
var pluginDataDir = path.join(LiteLoader.path.data, "media_local_view");
var diagnosticLogPath = path.join(pluginDataDir, "diagnostic.log");

function logProbe(event, details = {}) {
  try {
    fs.mkdirSync(pluginDataDir, { recursive: true });
    fs.appendFileSync(
      diagnosticLogPath,
      `[${new Date().toISOString()}] ${event} ${JSON.stringify(details)}\n`,
      "utf-8"
    );
  } catch {}
}

function inspectMedia(value) {
  const keys = [];
  const candidates = [];
  const seen = new WeakSet();

  function visit(current, currentPath, depth) {
    if (current == null || depth > 6 || keys.length >= 200) return;
    if (typeof current === "string") {
      if (/^(https?|file|appimg):|\.(avif|gif|jpe?g|png|webp)(\?|$)/i.test(current)) {
        candidates.push({ path: currentPath, value: current });
      }
      return;
    }
    if (typeof current !== "object" || seen.has(current)) return;
    seen.add(current);

    for (const key of Object.keys(current)) {
      const child = current[key];
      const childPath = `${currentPath}.${key}`;
      keys.push({ path: childPath, type: Array.isArray(child) ? "array" : typeof child });
      visit(child, childPath, depth + 1);
    }
  }

  visit(value, "$", 0);
  return { keys, candidates };
}

function prepareAppImage(originPath) {
  if (typeof originPath !== "string" || !originPath.startsWith("appimg://")) return null;

  const sourcePath = path.normalize(decodeURIComponent(originPath.slice("appimg://".length)));
  if (!fs.existsSync(sourcePath)) return null;
  if (path.extname(sourcePath)) return sourcePath;

  const signature = Buffer.alloc(12);
  const file = fs.openSync(sourcePath, "r");
  try {
    fs.readSync(file, signature, 0, signature.length, 0);
  } finally {
    fs.closeSync(file);
  }

  let extension = null;
  if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
    extension = ".jpg";
  } else if (signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    extension = ".png";
  } else if (signature.subarray(0, 4).toString("ascii") === "GIF8") {
    extension = ".gif";
  } else if (signature.subarray(0, 4).toString("ascii") === "RIFF" && signature.subarray(8, 12).toString("ascii") === "WEBP") {
    extension = ".webp";
  }
  if (!extension) return null;

  const cacheDir = path.join(pluginDataDir, "avatar-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${path.basename(sourcePath)}${extension}`);
  fs.copyFileSync(sourcePath, cachePath);
  logProbe("media.avatar-cached", { sourcePath, cachePath });
  return cachePath;
}

logProbe("module.load", { versions: process.versions });

var sampleConfig = {
  localVideo: true,
  localPic: true,
  macOSBuiltinPreview: true,
  windowsQuickLook: false,
};

var nowConfig = {};

function initConfig() {
  if (!fs.existsSync(pluginDataDir)) {
    fs.mkdirSync(pluginDataDir, { recursive: true });
  }
  fs.writeFileSync(
    configFilePath,
    JSON.stringify(sampleConfig, null, 2),
    "utf-8"
  );
}

function loadConfig() {
  if (!fs.existsSync(configFilePath)) {
    initConfig();
    return sampleConfig;
  } else {
    return JSON.parse(fs.readFileSync(configFilePath, "utf-8"));
  }
}

function saveConfig() {
  if (!fs.existsSync(configFilePath)) {
    initConfig();
  }
  fs.writeFileSync(configFilePath, JSON.stringify(nowConfig, null, 2), "utf-8");
}

async function useWindowsQuickLookInner(url) {
  return new Promise(async (accept, reject) => {
    //适配Windows QuickLook
    try {
      pipePath =
        process.platform === "win32"
          ? path.join(
            "\\\\.\\pipe\\",
            `QuickLook.App.Pipe.${await getUserSid()}`
          )
          : null;

      if (pipePath != null) {
        var pipeClient = net.createConnection(pipePath, () => {
          pipeClient.write(`QuickLook.App.PipeMessages.Toggle|${url}`);
        });
        pipeClient.on("connect", () => {
          output("Windows QuickLook pipe connected");
          accept();
        });
        pipeClient.on("error", (err) => {
          output("Error: Windows QuickLook pipe error occured", err);
          reject(
            "连接 Windows QuickLook 出现错误，请确保它已经在后台运行：" +
            JSON.stringify(err)
          );
        });
        pipeClient.on("close", () => {
          // output("Windows QuickLook pipe disconnected");
        });
      } else {
        output("Error: Only support Windows");
        reject("仅支持Windows系统");
      }
    } catch (err) {
      output("Windows QuickLook pipe error occured", err);
      reject(
        "连接 Windows QuickLook 出现错误，请确保它已经在后台运行：" +
        JSON.stringify(err)
      );
    }
  });
}

async function useWindowsQuickLook(url) {
  try {
    await useWindowsQuickLookInner(url);
  } catch (err) {
    nowConfig.windowsQuickLook = false;
    saveConfig();
    app.whenReady().then(() => {
      dialog.showMessageBox({
        type: "error",
        title: "错误",
        message:
          err +
          "。因为出错，已自动关闭 Windows QuickLook 支持，请检查环境后手动重新开启。",
        buttons: ["确定"],
      });
    });
  }
}

async function getUserSid() {
  return new Promise((accept) => {
    exec("whoami /user", (error, stdout, stderr) => {
      accept(stdout.match(/S-\d-\d+-(\d+-){1,14}\d+/)[0]);
    });
  });
}

onLoad();

function onLoad() {
  ipcMain.handle(
    "LiteLoader.media_local_view.getNowConfig",
    async (event, message) => {
      return nowConfig;
    }
  );

  ipcMain.handle(
    "LiteLoader.media_local_view.saveConfig",
    async (event, config) => {
      nowConfig = config;
      saveConfig();
    }
  );

  configFilePath = path.join(pluginDataDir, "config.json");
  nowConfig = loadConfig();

  if (nowConfig.localVideo == null) {
    nowConfig.localVideo = true;
  }
  if (nowConfig.localPic == null) {
    nowConfig.localPic = true;
  }
  if (nowConfig.macOSBuiltinPreview == null) {
    nowConfig.macOSBuiltinPreview = true;
  }

  fs.writeFileSync(configFilePath, JSON.stringify(nowConfig, null, 2), "utf-8");
}

var hookedWebContents = new WeakSet();
var loggedIpcNames = new Set();
function onBrowserWindowCreated(window) {
  logProbe("window.created", {
    id: window.id,
    url: window.webContents.getURL(),
  });

  window.webContents.on("did-stop-loading", () => {
    const url = window.webContents.getURL();
    //只针对主界面和独立聊天界面生效
    if (
      url.indexOf("#/main/message") != -1 ||
      url.indexOf("#/chat") != -1 ||
      url.indexOf("#/forward") != -1 ||
      url.indexOf("#/record") != -1
    ) {
      if (hookedWebContents.has(window.webContents)) return;
      hookedWebContents.add(window.webContents);

      logProbe("ipc.hook.install", {
        id: window.id,
        url,
        privateListeners: window.webContents.listenerCount("-ipc-message"),
        publicListeners: window.webContents.listenerCount("ipc-message"),
      });
      window.webContents.prependListener("-ipc-message", ipc_message);
      window.webContents.prependListener("ipc-message", ipc_message);

      function ipc_message(_, ...args) {
        try {
          const name = args.find(arg => typeof arg === "string");
          if (!loggedIpcNames.has(name) && loggedIpcNames.size < 100) {
            loggedIpcNames.add(name);
            logProbe("ipc.event", {
              name,
              argumentTypes: args.map(arg => Array.isArray(arg) ? "array" : typeof arg),
            });
          }

          if (args != null) {
            // 扁平化数组并查找 cmdName 为 "openMediaViewer" 的对象
            var allObjects = args.flat(Infinity).filter(item =>
              item &&
              typeof item === "object" &&
              item.cmdName === "openMediaViewer"
            );

            if (allObjects.length > 0) {
              var mediaViewerObj = allObjects[0];
              logProbe("media.command", {
                name,
                payloadType: Array.isArray(mediaViewerObj.payload) ? "array" : typeof mediaViewerObj.payload,
                payloadLength: mediaViewerObj.payload?.length,
              });

              if (mediaViewerObj.payload && mediaViewerObj.payload[0]) {
                var mediaViewerData = mediaViewerObj.payload[0];
                var mediaList = mediaViewerData.mediaList;
                var openedPicIndex = mediaViewerData.index;

                if (mediaList != null && mediaList.length > 0 && openedPicIndex < mediaList.length) {
                  var currentMedia = mediaList[openedPicIndex];
                  var handled = false;

                  // 处理图片
                  var picPath = currentMedia?.context?.sourcePath || prepareAppImage(currentMedia?.originPath);
                  logProbe("media.selected", {
                    index: openedPicIndex,
                    mediaCount: mediaList.length,
                    hasPicPath: picPath != null,
                    hasVideoPath: currentMedia?.context?.video?.path != null,
                  });
                  if (picPath != null && nowConfig.localPic == true) {
                    logProbe("media.open-picture", { path: picPath });
                    localOpen(picPath);
                    handled = true;
                  }

                  // 处理视频
                  var videoPath = currentMedia?.context?.video?.path;
                  if (videoPath != null && nowConfig.localVideo == true) {
                    logProbe("media.open-video", { path: videoPath });
                    localOpen(videoPath);
                    handled = true;
                  }

                  if (handled) {
                    if (typeof _?.preventDefault === "function") {
                      _.preventDefault();
                    }
                    mediaViewerObj.cmdName = "";
                    mediaViewerObj.payload = [];
                    logProbe("media.command-suppressed", {
                      defaultPrevented: Boolean(_?.defaultPrevented),
                    });
                  } else {
                    logProbe("media.unresolved", inspectMedia(currentMedia));
                  }
                }
              }
            }
          }
        } catch (e) {
          logProbe("ipc.error", { message: e.message, stack: e.stack });
          output(
            "NTQQ Image-Local-View Error: ",
            e,
            "Please report this to https://github.com/xh321/LiteLoaderQQNT-Image-Local-View/issues, thank you"
          );
        }
      }

      async function localOpen(path) {
        logProbe("local-open.request", { path, exists: fs.existsSync(path) });
        var openOrPreview = async (path) => {
          if (
            nowConfig.macOSBuiltinPreview == true &&
            process.platform == "darwin"
          ) {
            window.previewFile(path);
          } else if (
            nowConfig.windowsQuickLook == true &&
            process.platform == "win32"
          ) {
            await useWindowsQuickLook(path);
          } else {
            var ret = await shell.openPath(path);
            logProbe("local-open.result", { path, error: ret });
            if (ret != "") {
              dialog.showMessageBox({
                type: "error",
                title: "错误",
                message: "打开图片或视频错误，错误原因：" + ret,
                buttons: ["确定"],
              });
            }
          }
        };
        try {
          if (fs.existsSync(path)) {
            await openOrPreview(path);
          } else {
            var interval = setInterval(async () => {
              if (fs.existsSync(path)) {
                clearInterval(interval);
                await openOrPreview(path);
              }
            }, 100);
          }
        } catch (e) {
          logProbe("local-open.error", { message: e.message, stack: e.stack });
          output(
            "NTQQ Image-Local-View Error: ",
            e,
            "Please report this to https://github.com/xh321/LiteLoaderQQNT-Image-Local-View/issues, thank you"
          );
        }
      }

      output(
        "NTQQ Image-Local-View for window: " + window.webContents.getURL()
      );
    }
  });
}

function output(...args) {
  console.log("\x1b[32m%s\x1b[0m", "Image-Local-View:", ...args);
}

module.exports = {
  onBrowserWindowCreated,
};
