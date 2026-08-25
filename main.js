const fs = require("fs");
const path = require("path");
const net = require("net");
const exec = require("child_process").exec;
const { shell, dialog, ipcMain, app } = require("electron");

var configFilePath = "";
var pipePath = null;
var pluginDataDir = path.join(LiteLoader.path.data, "media_local_view");

// QQNT 9.9.23 的 appimg 头像文件没有扩展名，需要补全后再交给系统查看器。
function prepareAppImage(originPath) {
  if (typeof originPath !== "string" || !originPath.startsWith("appimg://")) return null;

  let sourcePath;
  try {
    sourcePath = path.normalize(
      decodeURIComponent(originPath.slice("appimg://".length))
    );
  } catch {
    return null;
  }
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
  } else if (
    signature
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    extension = ".png";
  } else if (signature.subarray(0, 4).toString("ascii") === "GIF8") {
    extension = ".gif";
  } else if (
    signature.subarray(0, 4).toString("ascii") === "RIFF" &&
    signature.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    extension = ".webp";
  }
  if (!extension) return null;

  const cacheDir = path.join(pluginDataDir, "avatar-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${path.basename(sourcePath)}${extension}`);
  fs.copyFileSync(sourcePath, cachePath);
  return cachePath;
}

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
function onBrowserWindowCreated(window) {
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
      window.webContents.prependListener("ipc-message", ipc_message);

      function ipc_message(event, ...args) {
        try {
          const mediaViewerObj = args.flat(Infinity).find(item =>
            item &&
            typeof item === "object" &&
            item.cmdName === "openMediaViewer"
          );
          const mediaViewerData = mediaViewerObj?.payload?.[0];
          const mediaList = mediaViewerData?.mediaList;
          const openedPicIndex = mediaViewerData?.index;
          if (!mediaList?.length || openedPicIndex >= mediaList.length) return;

          const currentMedia = mediaList[openedPicIndex];
          const picPath = currentMedia?.context?.sourcePath ||
            prepareAppImage(currentMedia?.originPath);
          const videoPath = currentMedia?.context?.video?.path;
          var handled = false;

          if (picPath != null && nowConfig.localPic == true) {
            localOpen(picPath);
            handled = true;
          } else if (videoPath != null && nowConfig.localVideo == true) {
            localOpen(videoPath);
            handled = true;
          }

          if (handled) {
            event.preventDefault();
            mediaViewerObj.cmdName = "";
            mediaViewerObj.payload = [];
          }
        } catch (e) {
          output(
            "NTQQ Image-Local-View Error: ",
            e,
            "Please report this to https://github.com/xh321/LiteLoaderQQNT-Image-Local-View/issues, thank you"
          );
        }
      }

      async function localOpen(path) {
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
          output(
            "NTQQ Image-Local-View Error: ",
            e,
            "Please report this to https://github.com/xh321/LiteLoaderQQNT-Image-Local-View/issues, thank you"
          );
        }
      }
    }
  });
}

function output(...args) {
  console.log("\x1b[32m%s\x1b[0m", "Image-Local-View:", ...args);
}

module.exports = {
  onBrowserWindowCreated,
};
