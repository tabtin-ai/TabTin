# Device Operations · FC 工具说明（路径 A）

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

> 仅当你的工具列表里能看到这三个工具时使用。本地 runtime（Electron / Daemon）请跳到下一节。

### get_device_info

读取能力设备的基础身份信息：平台、系统名、系统版本、型号、设备名称。

```
get_device_info()
```

返回示例：

```json
{
  "success": true,
  "data": {
    "platform": "ios",
    "system_name": "iOS",
    "system_version": "18.2",
    "model": "iPhone",
    "name": "Demo iPhone"
  }
}
```

### get_battery_info

读取能力设备的电池状态：电量百分比、充电状态、低电量模式。

```
get_battery_info()
```

返回示例：

```json
{
  "success": true,
  "data": {
    "level_percent": 82,
    "state": "charging",
    "low_power_mode_enabled": false
  }
}
```

### get_network_info

读取能力设备的联网状态：是否连接、连接类型是 `wifi` 还是 `cellular`。

```
get_network_info()
```

返回示例：

```json
{
  "success": true,
  "data": {
    "connected": true,
    "connection_type": "wifi"
  }
}
```
