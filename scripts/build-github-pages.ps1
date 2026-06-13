param(
    [string]$AppDeployAppId = "932f5348aea14e86a7",
    [string]$OutputDir = "_site"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sourcePath = Join-Path $projectRoot "index.html"
$outputPath = Join-Path $projectRoot $OutputDir

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "index.html not found: $sourcePath"
}

$html = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
$appDeployApiBase = "https://api-v2.appdeploy.ai/app/$AppDeployAppId"

$bridgeTemplate = @'
  <script>
    window.appApi = {
      async get(path) {
        const url = new URL(path, "__APPDEPLOY_API_BASE__");
        const response = await fetch(url.toString(), {
          headers: { "Accept": "application/json" }
        });
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (error) {
          throw new Error("\u5f8c\u7aef\u56de\u50b3\u4e0d\u662f JSON\uff0c\u8acb\u6aa2\u67e5 AppDeploy API\u3002");
        }
        if (!response.ok) {
          throw new Error(data?.message || "API request failed: " + response.status);
        }
        return { data };
      }
    };
    window.dispatchEvent(new Event("app-api-ready"));
  </script>
'@

$bridge = $bridgeTemplate.Replace("__APPDEPLOY_API_BASE__", $appDeployApiBase)

$moduleTag = '  <script type="module" src="./src/main.ts"></script>'
if (-not $html.Contains($moduleTag)) {
    throw "Expected AppDeploy client script tag was not found in index.html."
}

$pagesHtml = $html.Replace($moduleTag, $bridge)

if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

Set-Content -LiteralPath (Join-Path $outputPath "index.html") -Value $pagesHtml -Encoding UTF8
Set-Content -LiteralPath (Join-Path $outputPath ".nojekyll") -Value "" -Encoding UTF8
Set-Content -LiteralPath (Join-Path $outputPath "404.html") -Value $pagesHtml -Encoding UTF8

Write-Host "Built GitHub Pages artifact: $outputPath"
Write-Host "AppDeploy API base: $appDeployApiBase"
