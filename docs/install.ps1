<#
KubeAtlas installer for Windows.

  irm https://kubeatlas-org.github.io/kubeatlas/install.ps1 | iex

Downloads the latest release for your architecture, verifies its checksum,
installs it under %LOCALAPPDATA%\kubeatlas, and adds that to your user PATH.

Honest note: piping a remote script to your shell runs whatever it contains.
Feel free to read this first, or grab the .zip by hand from
https://github.com/kubeatlas-org/kubeatlas/releases instead.

Override the install dir with $env:KUBEATLAS_INSTALL_DIR.
#>

function Install-KubeAtlas {
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $repo = 'kubeatlas-org/kubeatlas'
    $base = "https://github.com/$repo/releases/latest/download"

    switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { $arch = 'amd64' }
        'ARM64' { $arch = 'arm64' }
        default { throw "unsupported architecture '$($env:PROCESSOR_ARCHITECTURE)' - builds are amd64 and arm64" }
    }
    $asset = "kubeatlas_windows_$arch.zip"

    $tmp = Join-Path $env:TEMP ("kubeatlas-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip  = Join-Path $tmp $asset
        $sums = Join-Path $tmp 'checksums.txt'

        Write-Host "Downloading $asset..."
        Invoke-WebRequest -Uri "$base/$asset"      -OutFile $zip  -UseBasicParsing
        Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile $sums -UseBasicParsing

        # Verify the checksum (checksums.txt lists "<sha256>  <filename>").
        $line = Get-Content $sums | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" } | Select-Object -First 1
        if (-not $line) { throw "no checksum listed for $asset" }
        $expected = ($line -split '\s+')[0]
        $actual   = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
        if ($actual.ToLower() -ne $expected.ToLower()) {
            throw "checksum mismatch (expected $expected, got $actual)"
        }
        Write-Host "Checksum verified."

        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $exe = Join-Path $tmp 'kubeatlas.exe'
        if (-not (Test-Path $exe)) { throw "archive did not contain kubeatlas.exe" }

        if ($env:KUBEATLAS_INSTALL_DIR) {
            $dir = $env:KUBEATLAS_INSTALL_DIR
        } else {
            $dir = Join-Path $env:LOCALAPPDATA 'kubeatlas'
        }
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Copy-Item -Path $exe -Destination (Join-Path $dir 'kubeatlas.exe') -Force
        Write-Host "Installed kubeatlas to $dir\kubeatlas.exe"

        # Add to the user PATH (the standard, non-admin way on Windows) if missing.
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($userPath -split ';') -notcontains $dir) {
            $newPath = if ($userPath) { "$userPath;$dir" } else { $dir }
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            $env:Path = "$env:Path;$dir"  # make it work in this session too
            Write-Host "Added $dir to your user PATH (reopen other terminals to pick it up)."
        }

        Write-Host ""
        Write-Host "KubeAtlas reads your kubeconfig and acts with that user's cluster"
        Write-Host "permissions - run it as the user whose access you intend."
        Write-Host ""
        Write-Host "It's early and under active development: expect rough edges, don't use"
        Write-Host "it for mission-critical work, and please send feedback / report bugs at"
        Write-Host "  https://github.com/$repo/issues"
        Write-Host ""
        Write-Host "Run it:  kubeatlas"
    }
    finally {
        Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-KubeAtlas
