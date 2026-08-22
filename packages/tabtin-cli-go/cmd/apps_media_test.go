package cmd

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestMediaImageModelsUsesSceneScopedImageCatalog(t *testing.T) {
	media := newCmdMedia(cmdutil.NewFactory())
	models, _, err := media.Find([]string{"image", "models"})
	if err != nil || models == nil {
		t.Fatalf("media image models 未挂载: err=%v", err)
	}

	def := cmdutil.GetCommandDef(models)
	if def == nil {
		t.Fatal("media image models 缺少 CommandDef")
	}
	if def.Path != "/media/catalog?task_type=text2image" {
		t.Fatalf("media image models 必须只查询生图场景目录，实际路径=%q", def.Path)
	}
}
