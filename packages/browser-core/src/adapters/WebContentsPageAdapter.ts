/**
 * WebContents 到 Page 接口的适配器（browser-core 本地副本）
 *
 * 将 Electron WebContents 适配为 AccessibilityTreeBuilder 需要的 Page 接口。
 */

export interface Page {
  content(): Promise<string>;
  accessibility: {
    snapshot(options?: { interestingOnly?: boolean }): Promise<{ nodes: any[] }>;
  };
}

export class WebContentsPageAdapter implements Page {
  private static callCounter = 0;

  public rootBackendNodeId?: number;

  constructor(private webContents: any) {}

  async content(): Promise<string> {
    return await this.webContents.executeJavaScript(`document.documentElement.outerHTML`);
  }

  accessibility = {
    snapshot: async (options?: { interestingOnly?: boolean }): Promise<{ nodes: any[] }> => {
      const cdpDebugger = this.webContents.debugger;
      const callNumber = ++WebContentsPageAdapter.callCounter;

      console.log(`[WebContentsPageAdapter] 📋 [调用#${callNumber}] 开始获取 Accessibility Tree`, {
        isAttached: cdpDebugger.isAttached(),
        options,
        rootBackendNodeId: this.rootBackendNodeId,
      });

      try {
        let result;

        if (this.rootBackendNodeId) {
          console.log(`[WebContentsPageAdapter] 🔍 使用 rootBackendNodeId=${this.rootBackendNodeId} 获取局部树`);
          result = await cdpDebugger.sendCommand('Accessibility.getPartialAXTree', {
            backendNodeId: this.rootBackendNodeId,
            fetchRelatives: false,
          });
        } else {
          result = await cdpDebugger.sendCommand('Accessibility.getFullAXTree', {
            depth: -1,
          });
        }

        console.log(`[WebContentsPageAdapter] ✅ [调用#${callNumber}] Accessibility Tree 获取成功:`, {
          nodeCount: result?.nodes?.length || 0,
        });

        return { nodes: result?.nodes || [] };
      } catch (error) {
        console.error(`[WebContentsPageAdapter] ❌ [调用#${callNumber}] 获取 Accessibility Tree 失败:`, error);
        return { nodes: [] };
      }
    },
  };

  getWebContents() {
    return this.webContents;
  }
}
