param(
  [int]$FrontendPort = 4173,
  [int]$BackendPort = 8000,
  [int]$DatabasePort = 15432,
  [string]$PostgresBin = $env:VMRB_POSTGRES_BIN,
  [string]$NvSegmentDir = $env:NV_SEGMENT_CT_DIR
)
$ErrorActionPreference = 'Stop'

function Test-NativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  # Windows PowerShell converts redirected native stderr into NativeCommandError.
  # Dependency and service probes are expected to fail, so inspect their exit
  # codes without allowing probe output to terminate the launcher.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & $FilePath @ArgumentList *> $null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Test-TcpPortInUse {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1)
}

function Assert-PreviewPidAvailable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PidPath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommand,
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  if (-not (Test-Path -LiteralPath $PidPath)) { return }
  $storedPid = 0
  $validPid = [int]::TryParse((Get-Content -LiteralPath $PidPath -Raw).Trim(), [ref]$storedPid)
  $processInfo = if ($validPid) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$storedPid" -ErrorAction SilentlyContinue
  } else { $null }
  if ($processInfo -and $processInfo.CommandLine -and $processInfo.CommandLine.Contains($ExpectedCommand)) {
    throw "Preview process already running on port $Port. Use scripts/stop-preview.ps1 before restarting."
  }

  # The process exited or Windows reused its PID. Removing only this launcher's
  # bookkeeping file is safe and lets a crashed preview restart normally.
  Remove-Item -LiteralPath $PidPath
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$previewRoot = Join-Path $projectRoot '.cache\preview'
$backendRoot = Join-Path $projectRoot 'backend'
$frontendRoot = $projectRoot
$pythonExe = Join-Path $backendRoot '.venv\Scripts\python.exe'
$clusterRoot = Join-Path $previewRoot 'postgres'
New-Item -ItemType Directory -Force -Path $previewRoot | Out-Null
$uv = Get-Command uv.exe -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $pythonExe)) {
  if (-not $uv) { throw 'Install uv, then run uv sync --locked --project backend.' }
  & $uv.Source sync --locked --project $backendRoot
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonExe)) {
    throw 'Backend dependency installation failed.'
  }
}
$skipNvSegmentSetup = $env:VMRB_SKIP_NV_SEGMENT_SETUP -eq '1'
$enableNvSegment = -not $skipNvSegmentSetup -and ($env:VMRB_ENABLE_NV_SEGMENT -eq '1' -or [bool]$NvSegmentDir)
if ($env:VMRB_ENABLE_NV_SEGMENT -eq '1' -and -not $NvSegmentDir -and (Test-Path -LiteralPath 'D:\NV-Segment-CTMR')) {
  $NvSegmentDir = 'D:\NV-Segment-CTMR'
}
if ($enableNvSegment -and -not $NvSegmentDir) {
  throw 'VMRB_ENABLE_NV_SEGMENT=1 requires NV_SEGMENT_CT_DIR (or D:\NV-Segment-CTMR).'
}
if ($enableNvSegment -and $NvSegmentDir) {
  $resolvedNvSegmentDir = (Resolve-Path -LiteralPath $NvSegmentDir -ErrorAction Stop).Path
  $modelHelper = Join-Path $resolvedNvSegmentDir 'hugging_face_pipeline.py'
  $modelWeights = Join-Path $resolvedNvSegmentDir 'vista3d_pretrained_model\model.pt'
  if (-not (Test-Path -LiteralPath $modelHelper) -or -not (Test-Path -LiteralPath $modelWeights)) {
    throw "NV-Segment-CTMR is incomplete at $resolvedNvSegmentDir; expected hugging_face_pipeline.py and vista3d_pretrained_model/model.pt."
  }
  $nvRuntimeReady = Test-NativeCommand -FilePath $pythonExe -ArgumentList @(
    '-c',
    'import monai, torch, transformers'
  )
  if (-not $nvRuntimeReady) {
    if ($env:VMRB_INSTALL_NV_RUNTIME -eq '1') {
      if (-not $uv) { throw 'Install uv so the NV-Segment-CTMR runtime dependencies can be installed.' }
      Write-Output 'Installing NV-Segment-CTMR runtime dependencies (explicitly requested)...'
      & $uv.Source pip install --python $pythonExe -r (Join-Path $backendRoot 'requirements-nv.txt')
      if ($LASTEXITCODE -ne 0) { throw 'NV-Segment-CTMR runtime dependency installation failed.' }
    } else {
      Write-Warning 'NV-Segment-CTMR dependencies are missing. The app will start, but segmentation stays unavailable. Set VMRB_INSTALL_NV_RUNTIME=1 for the one-time install.'
    }
  }
  $env:NV_SEGMENT_CT_DIR = $resolvedNvSegmentDir
  $env:NV_SEGMENT_DEVICE = if ($env:NV_SEGMENT_DEVICE) { $env:NV_SEGMENT_DEVICE } else { 'cuda:0' }
  $env:NV_SEGMENT_ROI_SIZE = if ($env:NV_SEGMENT_ROI_SIZE) { $env:NV_SEGMENT_ROI_SIZE } else { '[192,192,128]' }
  $env:NV_SEGMENT_OVERLAP = if ($env:NV_SEGMENT_OVERLAP) { $env:NV_SEGMENT_OVERLAP } else { '0.3' }
  Write-Output "NV-Segment-CTMR connected: $resolvedNvSegmentDir"
}
if (-not $PostgresBin) {
  $initdb = Get-Command initdb.exe -ErrorAction SilentlyContinue
  if ($initdb) {
    $PostgresBin = Split-Path -Parent $initdb.Source
  } else {
    $postgresRoot = Join-Path $env:ProgramFiles 'PostgreSQL'
    $installation = Get-ChildItem -LiteralPath $postgresRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\initdb.exe') } |
      Select-Object -First 1
    if ($installation) { $PostgresBin = Join-Path $installation.FullName 'bin' }
  }
}
if (-not $PostgresBin -or -not (Test-Path -LiteralPath (Join-Path $PostgresBin 'initdb.exe'))) {
  throw 'PostgreSQL tools were not found. Add them to PATH or set VMRB_POSTGRES_BIN.'
}
$PostgresBin | Set-Content -LiteralPath (Join-Path $previewRoot 'postgres-bin')
$passwordFile = Join-Path $previewRoot 'db-password'
if (-not (Test-Path -LiteralPath $passwordFile)) {
  & $pythonExe -c "import secrets,sys; from pathlib import Path; Path(sys.argv[1]).write_text(secrets.token_urlsafe(32))" $passwordFile
  if ($LASTEXITCODE -ne 0) { throw 'Cannot generate preview database password.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $clusterRoot 'PG_VERSION'))) {
  & (Join-Path $PostgresBin 'initdb.exe') -D $clusterRoot -U vmrb --auth=scram-sha-256 "--pwfile=$passwordFile" --encoding=UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) { throw 'Preview database initialization failed.' }
}
$postgresRunning = Test-NativeCommand -FilePath (Join-Path $PostgresBin 'pg_ctl.exe') -ArgumentList @(
  '-D',
  $clusterRoot,
  'status'
)
$databasePortPath = Join-Path $previewRoot 'database-port'
if ($postgresRunning) {
  if (Test-Path -LiteralPath $databasePortPath) {
    $DatabasePort = [int]((Get-Content -LiteralPath $databasePortPath -Raw).Trim())
  } else {
    $postmasterPidLines = Get-Content -LiteralPath (Join-Path $clusterRoot 'postmaster.pid')
    if ($postmasterPidLines.Count -ge 4) { $DatabasePort = [int]$postmasterPidLines[3] }
  }
} else {
  if (Test-TcpPortInUse -Port $DatabasePort) {
    $availableDatabasePort = (($DatabasePort + 1)..($DatabasePort + 20) |
      Where-Object { -not (Test-TcpPortInUse -Port $_) } |
      Select-Object -First 1)
    if (-not $availableDatabasePort) {
      throw "PostgreSQL ports $DatabasePort-$($DatabasePort + 20) are already in use."
    }
    Write-Output "Database port $DatabasePort is occupied; using $availableDatabasePort for this checkout."
    $DatabasePort = $availableDatabasePort
  }
  $DatabasePort | Set-Content -LiteralPath $databasePortPath
  & (Join-Path $PostgresBin 'pg_ctl.exe') -D $clusterRoot -l (Join-Path $previewRoot 'postgres.log') -o "-h 127.0.0.1 -p $DatabasePort" -w start
  if ($LASTEXITCODE -ne 0) {
    throw 'Preview database failed to start; inspect .cache/preview/postgres.log.'
  }
}
$databaseReady = Test-NativeCommand -FilePath (Join-Path $PostgresBin 'pg_isready.exe') -ArgumentList @(
  '-h',
  '127.0.0.1',
  '-p',
  [string]$DatabasePort,
  '-U',
  'vmrb'
)
if (-not $databaseReady) { throw 'Preview database did not become ready; inspect .cache/preview/postgres.log.' }
$previewPassword = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
$env:DATABASE_URL = 'postgresql+psycopg://vmrb:' + $previewPassword + '@127.0.0.1:' + $DatabasePort + '/postgres'
& $pythonExe -c "import os; from sqlalchemy import create_engine,text; e=create_engine(os.environ['DATABASE_URL'],isolation_level='AUTOCOMMIT'); c=e.connect(); exists=c.execute(text('SELECT 1 FROM pg_database WHERE datname=:name'),{'name':'vmrb_preview'}).scalar(); c.execute(text('CREATE DATABASE vmrb_preview')) if not exists else None; c.close(); e.dispose()"
if ($LASTEXITCODE -ne 0) { throw 'Cannot create preview database.' }
$env:DATABASE_URL = 'postgresql+psycopg://vmrb:' + $previewPassword + '@127.0.0.1:' + $DatabasePort + '/vmrb_preview'
$env:STORAGE_ROOT = Join-Path $previewRoot 'medical-data'
Push-Location $backendRoot
try {
  & $pythonExe -m alembic upgrade head
  if ($LASTEXITCODE -ne 0) { throw 'Migration failed.' }
  $env:VMRB_DEMO_SEED = '1'
  & $pythonExe -m app.demo
  if ($LASTEXITCODE -ne 0) { throw 'Preview data creation failed.' }
} finally { Pop-Location }
$backendPidPath = Join-Path $previewRoot 'backend.pid'
$frontendPidPath = Join-Path $previewRoot 'frontend.pid'
Assert-PreviewPidAvailable -PidPath $backendPidPath -ExpectedCommand 'app.main:create_app' -Port $BackendPort
Assert-PreviewPidAvailable -PidPath $frontendPidPath -ExpectedCommand 'node_modules\vite\bin\vite.js' -Port $FrontendPort
# `pnpm start:demo`, Playwright, or an interrupted Vite session can leave this
# checkout listening on the default frontend port without a preview PID file.
# Starting the full stack is an explicit request to replace that same-project
# demo, otherwise users keep opening the backend-less page at :4173.
if (Test-TcpPortInUse -Port $FrontendPort) {
  $viteEntry = Join-Path $frontendRoot 'node_modules\vite\bin\vite.js'
  $sameProjectVite = Get-NetTCPConnection -State Listen -LocalPort $FrontendPort -ErrorAction SilentlyContinue |
    ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue } |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($viteEntry) } |
    Select-Object -First 1
  if ($sameProjectVite) {
    Write-Output "Replacing the backend-less Vite demo on port $FrontendPort with the full-stack frontend."
    Stop-Process -Id $sameProjectVite.ProcessId
    for ($i = 0; $i -lt 20 -and (Test-TcpPortInUse -Port $FrontendPort); $i++) {
      Start-Sleep -Milliseconds 100
    }
  }
}
if (Test-TcpPortInUse -Port $BackendPort) {
  $availableBackendPort = (($BackendPort + 1)..($BackendPort + 20) |
    Where-Object { -not (Test-TcpPortInUse -Port $_) } |
    Select-Object -First 1)
  if (-not $availableBackendPort) { throw "Backend ports $BackendPort-$($BackendPort + 20) are already in use." }
  Write-Output "Backend port $BackendPort is occupied; using $availableBackendPort for this checkout."
  $BackendPort = $availableBackendPort
}
if (Test-TcpPortInUse -Port $FrontendPort) {
  $availableFrontendPort = (($FrontendPort + 1)..($FrontendPort + 20) |
    Where-Object { -not (Test-TcpPortInUse -Port $_) } |
    Select-Object -First 1)
  if (-not $availableFrontendPort) { throw "Frontend ports $FrontendPort-$($FrontendPort + 20) are already in use." }
  Write-Output "Frontend port $FrontendPort is occupied; using $availableFrontendPort for this checkout."
  $FrontendPort = $availableFrontendPort
}
$BackendPort | Set-Content -LiteralPath (Join-Path $previewRoot 'backend-port')
$FrontendPort | Set-Content -LiteralPath (Join-Path $previewRoot 'frontend-port')
$backendArgs = @('-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', $BackendPort, '--workers', '1', '--no-access-log')
$env:BACKEND_INTERNAL_URL = 'http://127.0.0.1:' + $BackendPort
$backendProcess = Start-Process -FilePath $pythonExe -ArgumentList $backendArgs -WorkingDirectory $backendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewRoot 'backend.log') -RedirectStandardError (Join-Path $previewRoot 'backend-error.log')
$backendProcess.Id | Set-Content -LiteralPath $backendPidPath
$env:VITE_LOCAL_PREVIEW = 'false'
$env:VITE_PREVIEW = 'true'
$env:VMRB_BACKEND_URL = 'http://127.0.0.1:' + $BackendPort
$nodeExe = (Get-Command node.exe).Source
$viteEntry = Join-Path $frontendRoot 'node_modules\vite\bin\vite.js'
$frontendProcess = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + $viteEntry + '"'), '--host', '127.0.0.1', '--port', $FrontendPort) -WorkingDirectory $frontendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewRoot 'frontend.log') -RedirectStandardError (Join-Path $previewRoot 'frontend-error.log')
$frontendProcess.Id | Set-Content -LiteralPath $frontendPidPath
$previewReady = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$FrontendPort/health" -TimeoutSec 2
    if ($health.data.status -eq 'ok') { $previewReady = $true; break }
  } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $previewReady) { throw 'Preview startup failed; inspect logs in .cache/preview and run stop-preview.ps1.' }
Write-Output "Preview starting: http://127.0.0.1:$FrontendPort"
Write-Output "Backend docs: http://127.0.0.1:$BackendPort/docs"
Write-Output 'Demo accounts: admin, demo_doctor, demo_patient, test_patient / 123456'
if (-not $env:VMRB_DEMO_SCAN_DIR) {
  Write-Output 'No demo scans were configured; upload a CT or set VMRB_DEMO_SCAN_DIR for seeded imaging.'
}
