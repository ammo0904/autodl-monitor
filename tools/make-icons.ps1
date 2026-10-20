param([Parameter(Mandatory = $true)][string]$OutDir)

# 產生 AutoDL 主機監控擴充套件用的圖示（純 System.Drawing 繪製，不需要外部素材）
#   用法： pwsh -File tools/make-icons.ps1 -OutDir icons
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$outDir = [System.IO.Path]::GetFullPath($OutDir)
if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$S = 512
$bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# 背景：圓角深藍漸層
$bg = New-RoundedPath 0 0 512 512 112
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF(40, 20)),
  (New-Object System.Drawing.PointF(470, 490)),
  ([System.Drawing.Color]::FromArgb(255, 59, 122, 255)),
  ([System.Drawing.Color]::FromArgb(255, 24, 58, 190)))
$g.FillPath($bgBrush, $bg)

# GPU 晶片：白色外框 + 內框（挖空回背景色）+ 兩側接腳
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$chipOuter = New-RoundedPath 132 168 212 176 30
$g.FillPath($white, $chipOuter)

$hole = New-RoundedPath 178 214 120 84 16
$holeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 68, 210))
$g.FillPath($holeBrush, $hole)

$pinBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
for ($i = 0; $i -lt 3; $i++) {
  $y = 196 + ($i * 56)
  $g.FillRectangle($pinBrush, 96, $y, 36, 20)   # 左側接腳
  $g.FillRectangle($pinBrush, 344, $y, 36, 20)  # 右側接腳
}

# 右下角綠燈：代表「有空閒 GPU」
$ring = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillEllipse($ring, 330, 330, 156, 156)
$green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 197, 94))
$g.FillEllipse($green, 350, 350, 116, 116)

$g.Dispose()

$sizes = @{ 'icon16.png' = 16; 'icon32.png' = 32; 'icon48.png' = 48; 'icon128.png' = 128 }
foreach ($name in $sizes.Keys) {
  $size = $sizes[$name]
  $target = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $tg = [System.Drawing.Graphics]::FromImage($target)
  $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $tg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $tg.Clear([System.Drawing.Color]::Transparent)
  $tg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $tg.Dispose()
  $path = Join-Path $outDir $name
  $target.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $target.Dispose()
  Write-Host ("wrote {0} ({1} bytes)" -f $path, (Get-Item $path).Length)
}
$bmp.Dispose()
