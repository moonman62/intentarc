const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const channels = {
  aiList: "intentarc:ai:list",
  aiConnect: "intentarc:ai:connect",
  aiCreateManual: "intentarc:ai:create-manual",
  aiTest: "intentarc:ai:test",
  aiRemove: "intentarc:ai:remove",
  aiRemoveManual: "intentarc:ai:remove-manual",
  aiLaunchForProject: "intentarc:ai:launch-for-project",
  lifecycleGetState: "intentarc:lifecycle:get-state",
  lifecycleChooseArchive: "intentarc:lifecycle:choose-archive",
  lifecycleCompleteOnboarding: "intentarc:lifecycle:complete-onboarding",
  lifecycleRestart: "intentarc:lifecycle:restart",
  updatesGetStatus: "intentarc:updates:get-status",
  updatesApplyAndRestart: "intentarc:updates:apply-and-restart",
  documentsOpenRepositoryFile: "intentarc:documents:open-repository-file",
  documentsOpenExternalHttps: "intentarc:documents:open-external-https",
  repositoryChooseDirectory: "intentarc:repository:choose-directory",
} as const;

contextBridge.exposeInMainWorld("intentArcDesktop", {
  ai: {
    list: () => ipcRenderer.invoke(channels.aiList),
    connect: (adapterId: unknown) =>
      ipcRenderer.invoke(channels.aiConnect, adapterId),
    test: (adapterId: unknown) =>
      ipcRenderer.invoke(channels.aiTest, adapterId),
    remove: (adapterId: unknown) =>
      ipcRenderer.invoke(channels.aiRemove, adapterId),
    createManual: (input: unknown) =>
      ipcRenderer.invoke(channels.aiCreateManual, input),
    removeManual: (id: unknown) =>
      ipcRenderer.invoke(channels.aiRemoveManual, id),
    launchForProject: (input: unknown) =>
      ipcRenderer.invoke(channels.aiLaunchForProject, input),
  },
  lifecycle: {
    getState: () => ipcRenderer.invoke(channels.lifecycleGetState),
    chooseArchive: () =>
      ipcRenderer.invoke(channels.lifecycleChooseArchive),
    completeOnboarding: () =>
      ipcRenderer.invoke(channels.lifecycleCompleteOnboarding),
    restart: () => ipcRenderer.invoke(channels.lifecycleRestart),
  },
  updates: {
    getStatus: () => ipcRenderer.invoke(channels.updatesGetStatus),
    applyAndRestart: () =>
      ipcRenderer.invoke(channels.updatesApplyAndRestart),
  },
  documents: {
    externalOpenAvailable: true,
    openRepositoryFile: (projectId: unknown, nodeId: unknown) =>
      ipcRenderer.invoke(channels.documentsOpenRepositoryFile, {
        projectId,
        nodeId,
      }),
    openExternalHttps: (url: unknown) =>
      ipcRenderer.invoke(channels.documentsOpenExternalHttps, url),
  },
  repository: {
    chooseRepositoryDirectory: () =>
      ipcRenderer.invoke(channels.repositoryChooseDirectory),
  },
});
