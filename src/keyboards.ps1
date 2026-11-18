# Keyboards Windows sees right now, one row per physical device (read-only).
# A keyboard shows up as several "HID Keyboard Device" entries (one per HID collection / interface); they are grouped
# by vendor+product id (USB) or by the Bluetooth device. Built-in laptop keyboards hang off ACPI (PS/2 or I2C HID).
# Dot-sourced by collect.ps1; run directly it prints JSON (used by the "Dò lại" button).
function Get-Keyboards {
    $prop = { param($id, $key) try { (Get-PnpDeviceProperty -InstanceId $id -KeyName $key -ErrorAction Stop).Data } catch { $null } }
    $groups = [ordered]@{}
    foreach ($k in @(Get-PnpDevice -Class Keyboard -PresentOnly -ErrorAction SilentlyContinue)) {
        $id = $k.InstanceId; $parent = & $prop $id 'DEVPKEY_Device_Parent'
        if ($id -match '^(SWD|ROOT)\\' -or $id -match 'TERMINPUT|RDP_KBD|VMBUS') { continue }  # virtual / remote desktop
        $kind = 'other'; $key = $id; $name = $null; $vidpid = $null
        if ($id -match '^ACPI\\' -or $parent -match '^ACPI\\') { $kind = 'builtin'; $key = 'builtin' }
        elseif ($id -match '\{0000(1124|1812)-' -or $parent -match '^(BTHENUM|BTHLEDEVICE)\\') {
            $kind = 'bluetooth'; $device = $parent
            if ($parent -match '^BTHLEDEVICE\\') { $device = & $prop $parent 'DEVPKEY_Device_Parent' }
            $key = $device; if ($device) { try { $name = (Get-PnpDevice -InstanceId $device -ErrorAction Stop).FriendlyName } catch {} }
        }
        elseif ($id -match 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})') {
            $kind = 'usb'; $vidpid = "$($Matches[1]):$($Matches[2])"; $key = "usb:$vidpid"
            $name = (& $prop $parent 'DEVPKEY_Device_BusReportedDeviceDesc')
            if (-not $name -or $name -match '^\s*USB (DEVICE|Composite Device|Input Device)\s*$') { $name = & $prop $id 'DEVPKEY_Device_BusReportedDeviceDesc' }
        }
        if (-not $groups.Contains($key)) { $groups[$key] = [pscustomobject]@{ Kind = $kind; Name = $(if ($name) { "$name".Trim() } else { $null }); VidPid = $vidpid; Interfaces = 0; Status = $k.Status } }
        $groups[$key].Interfaces++
        if ($k.Status -ne 'OK') { $groups[$key].Status = $k.Status }
    }
    @($groups.Values)
}
if ($MyInvocation.InvocationName -ne '.') { ConvertTo-Json -InputObject @(Get-Keyboards) -Depth 3 -Compress }
