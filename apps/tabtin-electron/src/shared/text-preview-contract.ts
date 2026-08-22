/** 主进程本地识别与 renderer 云端 registry 共用的无扩展名文本文件名。 */
export const TEXT_PREVIEW_FILENAMES = [
  'Makefile', 'Dockerfile', 'Vagrantfile', 'Procfile', 'Gemfile',
  'Rakefile', 'Brewfile', 'Justfile', 'Taskfile',
  'LICENSE', 'LICENCE', 'COPYING', 'AUTHORS', 'CONTRIBUTORS',
  'CHANGELOG', 'CHANGES', 'HISTORY', 'NEWS',
  'README', 'TODO', 'CONTRIBUTING', 'CODE_OF_CONDUCT',
  '.gitignore', '.gitattributes', '.gitmodules',
  '.dockerignore', '.editorconfig', '.prettierignore', '.eslintignore',
  '.npmignore', '.prettierrc', '.eslintrc', '.babelrc',
] as const
