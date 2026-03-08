# 机器人远程操控仿真与可视化平台

本项目已整理为 Docker 单一启动方式，避免本地 Python 虚拟环境和多套命令。

## 启动（唯一推荐）

在项目根目录执行：

先确认 Docker Desktop 已启动（Docker Engine 处于 Running）。

```bash
docker compose up --build
```

启动后访问：
- 前端：`http://localhost:8080`
- 后端健康检查：`http://localhost:8000/health`

## 停止

```bash
docker compose down
```

## 目录说明

- `docker-compose.yml`：前后端统一编排入口
- `backend/`：FastAPI 服务（容器内监听 `8000`）
- `frontend/`：Vite 构建 + Nginx 静态托管（容器内监听 `80`，映射到宿主机 `8080`）
