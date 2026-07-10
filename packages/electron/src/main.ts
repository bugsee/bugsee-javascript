// @bugsee/electron/main — the main-process entry. Imports @bugsee/node (never @bugsee/browser), so it's safe
// in the Node main process. See docs/design/electron.md.
export { type LaunchMainOptions, launchMain } from './launch-main';
export {
  createElectronMainReceiver,
  type ElectronMainReceiver,
  type ElectronMainReceiverOptions,
  type IpcMainEventLike,
  type IpcMainLike,
  type IpcMainListener,
} from './main-receiver';
