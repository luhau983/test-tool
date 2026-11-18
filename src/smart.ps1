param([string]$SmartOutput)
# Reads raw drive health data straight from the storage driver (decoded in disk-health.cjs).
# NVMe identify/health log and ATA identify/Device Statistics work without admin rights;
# the ATA SMART attribute table (SMART READ DATA / THRESHOLDS) needs an elevated process.
$ErrorActionPreference = 'Stop'
if (-not ('DiskReader' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DiskReader {
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte[] inBuf, int inLen, byte[] outBuf, int outLen, out int returned, IntPtr overlapped);
    const uint QueryProperty = 0x2D1400, SmartReceive = 0x7C088;

    static SafeFileHandle Open(int disk, uint access) {
        SafeFileHandle h = CreateFile(@"\\.\PhysicalDrive" + disk, access, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        return h;
    }
    // StorageDeviceProtocolSpecificProperty: protocol 2 = ATA, 3 = NVMe; dataType 1 = identify, 2 = log page.
    public static byte[] Protocol(int disk, int protocol, int dataType, int request, int sub, int length) {
        using (SafeFileHandle h = Open(disk, 0)) {
            byte[] buf = new byte[48 + length];
            BitConverter.GetBytes(50).CopyTo(buf, 0);
            BitConverter.GetBytes(protocol).CopyTo(buf, 8);
            BitConverter.GetBytes(dataType).CopyTo(buf, 12);
            BitConverter.GetBytes(request).CopyTo(buf, 16);
            BitConverter.GetBytes(sub).CopyTo(buf, 20);
            BitConverter.GetBytes(40).CopyTo(buf, 24);
            BitConverter.GetBytes(length).CopyTo(buf, 28);
            int returned;
            if (!DeviceIoControl(h, QueryProperty, buf, buf.Length, buf, buf.Length, out returned, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int offset = 8 + BitConverter.ToInt32(buf, 24), size = Math.Min(BitConverter.ToInt32(buf, 28), length);
            if (size <= 0 || offset + size > returned) throw new Exception("Driver returned no protocol data");
            byte[] data = new byte[size];
            Array.Copy(buf, offset, data, 0, size);
            return data;
        }
    }
    // SMART_RCV_DRIVE_DATA; feature 0xD0 = READ DATA, 0xD1 = READ THRESHOLDS. Needs read/write access (admin).
    public static byte[] Smart(int disk, byte feature) {
        using (SafeFileHandle h = Open(disk, 0xC0000000)) {
            byte[] input = new byte[33], output = new byte[16 + 512];
            BitConverter.GetBytes(512).CopyTo(input, 0);
            input[4] = feature; input[5] = 1; input[6] = 1; input[7] = 0x4F; input[8] = 0xC2; input[9] = 0xA0; input[10] = 0xB0;
            int returned;
            if (!DeviceIoControl(h, SmartReceive, input, input.Length, output, output.Length, out returned, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] data = new byte[512];
            Array.Copy(output, 16, data, 0, 512);
            return data;
        }
    }
}
'@
}

function Get-DiskSmart {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Get-PhysicalDisk -ErrorAction Stop | Sort-Object { [int]$_.DeviceId } | ForEach-Object {
        $n = [int]$_.DeviceId
        $r = [ordered]@{
            Index = $n; FriendlyName = $_.FriendlyName; SerialNumber = $_.SerialNumber; BusType = [string]$_.BusType
            MediaType = [string]$_.MediaType; Size = $_.Size; SpindleSpeed = $_.SpindleSpeed; HealthStatus = [string]$_.HealthStatus
            DriveLetters = ''; Protocol = $null; Identify = $null; HealthLog = $null; DevStats = [ordered]@{}
            SmartData = $null; SmartThresholds = $null; Admin = $admin; NeedsAdmin = $false; Errors = @()
        }
        try { $r.DriveLetters = (@(Get-Partition -DiskNumber $n -ErrorAction Stop | Where-Object DriveLetter | ForEach-Object { "$($_.DriveLetter):" }) -join ' ') } catch {}
        $b64 = { param($bytes) [Convert]::ToBase64String($bytes) }
        if ($r.BusType -eq 'NVMe') {
            $r.Protocol = 'nvme'
            try { $r.Identify = & $b64 ([DiskReader]::Protocol($n, 3, 1, 1, 0, 4096)) } catch { $r.Errors += "Identify NVMe: $($_.Exception.Message)" }
            try { $r.HealthLog = & $b64 ([DiskReader]::Protocol($n, 3, 2, 2, 0, 512)) } catch { $r.Errors += "SMART/Health NVMe: $($_.Exception.Message)" }
        } else {
            $r.Protocol = 'ata'
            try { $r.Identify = & $b64 ([DiskReader]::Protocol($n, 2, 1, 0, 0, 512)) } catch { $r.Errors += "Identify ATA: $($_.Exception.Message)" }
            try {
                $pages = [DiskReader]::Protocol($n, 2, 2, 4, 0, 512)
                for ($i = 0; $i -lt $pages[8] -and $i -lt 32; $i++) {
                    $page = $pages[9 + $i]
                    if ($page -ge 1 -and $page -le 7) { try { $r.DevStats["$page"] = & $b64 ([DiskReader]::Protocol($n, 2, 2, 4, $page, 512)) } catch {} }
                }
            } catch { $r.Errors += "Device Statistics: $($_.Exception.Message)" }
            try {
                $r.SmartData = & $b64 ([DiskReader]::Smart($n, 0xD0))
                try { $r.SmartThresholds = & $b64 ([DiskReader]::Smart($n, 0xD1)) } catch {}
            } catch {
                $inner = $_.Exception.InnerException
                if (-not $admin -and $inner -is [ComponentModel.Win32Exception] -and $inner.NativeErrorCode -eq 5) { $r.NeedsAdmin = $true }
                else { $r.Errors += "Bảng SMART: $($_.Exception.Message)" }
            }
        }
        [pscustomobject]$r
    }
}

if ($SmartOutput) {
    [ordered]@{ schema = 1; collectedAt = (Get-Date).ToUniversalTime().ToString('o'); disks = @(Get-DiskSmart) } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $SmartOutput -Encoding UTF8
}
