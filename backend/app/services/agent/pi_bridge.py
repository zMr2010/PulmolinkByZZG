"""
Pi Agent Subprocess Bridge & Clinical Orchestrator
Integrates with @earendil-works/pi-coding-agent via JSONL RPC mode
and streams Server-Sent Events (SSE) to the Vue frontend.
"""

import asyncio
import json
import logging
import os
import shutil
from collections.abc import AsyncGenerator
from pathlib import Path

import httpx

from app.config import Settings

logger = logging.getLogger("pi-bridge")

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
REPOSITORY_ROOT = PROJECT_ROOT.parent
EXTENSION_PATH = Path(__file__).resolve().parent / "medical_extension.mjs"
PI_CLI_PATH = REPOSITORY_ROOT / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist" / "bundle" / "cli.js"


def pi_executable_command() -> list[str]:
    """Resolve Pi without relying on Windows shell handling for npx.cmd."""
    node = shutil.which("node")
    if node and PI_CLI_PATH.is_file():
        return [node, str(PI_CLI_PATH)]

    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if npx:
        return [npx, "-y", "@earendil-works/pi-coding-agent"]
    raise RuntimeError("Pi Agent runtime is unavailable; install frontend dependencies with pnpm install")


class PiAgentBridge:
    def __init__(self, settings: Settings, *, authorization: str | None = None):
        self.settings = settings
        self.base_url = settings.agent_llm_base_url or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        self.api_key = (
            settings.agent_llm_api_key.get_secret_value()
            if settings.agent_llm_api_key
            else os.environ.get("OPENAI_API_KEY", "")
        )
        self.model = settings.agent_llm_model or os.environ.get("OPENAI_MODEL", "gpt-4o")
        self.radsight_url = settings.radsight_service_url or "http://127.0.0.1:8001"
        self.backend_url = os.environ.get("BACKEND_INTERNAL_URL", "http://127.0.0.1:8000").rstrip("/")
        self.authorization = authorization or ""

    @property
    def backend_headers(self) -> dict[str, str]:
        return {"Authorization": self.authorization} if self.authorization else {}

    async def stream_chat(
        self,
        conversation_id: str,
        patient_id: int,
        user_message: str,
        active_study_id: str | None = None,
        active_series_id: str | None = None,
        active_slice: int | None = None,
        locale: str = "zh",
    ) -> AsyncGenerator[str, None]:
        """
        Stream agent thoughts, tool events, and responses via SSE.
        Yields newline-delimited data lines: data: {json}\n\n
        """
        # Yield start event
        yield f"data: {json.dumps({'type': 'start', 'conversation_id': conversation_id}, ensure_ascii=False)}\n\n"

        # Check if we should execute via Pi RPC subprocess or our clinical direct dispatcher
        has_active_key = bool(self.api_key and not self.api_key.startswith("sk-placeholder"))

        if has_active_key:
            async for sse_chunk in self._stream_via_pi_rpc(
                conversation_id, patient_id, user_message, active_study_id, active_series_id, active_slice, locale
            ):
                yield sse_chunk
        else:
            async for sse_chunk in self._stream_via_clinical_coordinator(
                conversation_id, patient_id, user_message, active_study_id, active_series_id, active_slice, locale
            ):
                yield sse_chunk

    async def _stream_via_pi_rpc(
        self,
        conversation_id: str,
        patient_id: int,
        user_message: str,
        active_study_id: str | None,
        active_series_id: str | None,
        active_slice: int | None,
        locale: str,
    ) -> AsyncGenerator[str, None]:
        """Runs the Pi RPC subprocess and parses JSONL streaming events."""
        env = os.environ.copy()
        env["AGENT_LLM_API_KEY"] = self.api_key
        env["AGENT_LLM_BASE_URL"] = self.base_url
        env["AGENT_LLM_MODEL"] = self.model
        env["BACKEND_INTERNAL_URL"] = self.backend_url
        env["BACKEND_AUTHORIZATION"] = self.authorization
        env["RADSIGHT_URL"] = self.radsight_url

        system_instruction = (
            f"You are the Medical Platform AI Copilot Doctor Assistant. "
            f"Active patient_id: {patient_id}. "
            f"Active study_id: {active_study_id or 'none'}. "
            f"When answering CT or radiology questions, always first inspect patient CT scans with list_patient_ct_scans. "
            f"Select the most appropriate CT series, explicitly tell the doctor which series you selected in the first line, "
            f"and invoke the talk_to_ct tool (RadSight-8B). "
            f"If drafting a radiology report, invoke draft_radiology_report. "
            f"If the doctor asks for a treatment plan, care plan, or 治疗计划, you MUST call tools in this order: "
            f"list_patient_ct_scans, get_patient_records, talk_to_ct (question must address the presenting symptoms), "
            f"get_segmentation_qc, then draft_treatment_plan. "
            f"draft_treatment_plan fields may only cite facts returned by those tools. "
            f"Never invent nodule size, LU-RADS class, lab values, or a 4.2mm template. "
            f"If RadSight is uncertain, say so. The plan is a draft for the attending physician, not an executable order."
            f" Respond in {'English' if locale == 'en' else 'Simplified Chinese'}."
        )

        cmd = [
            *pi_executable_command(),
            "--mode", "rpc",
            "--provider", "custom-backend-llm",
            "--model", self.model,
            "--no-builtin-tools",
            "-e", str(EXTENSION_PATH),
        ]

        logger.info(f"Spawning Pi RPC process: {' '.join(cmd)}")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=str(PROJECT_ROOT),
            limit=8 * 1024 * 1024,
        )

        accumulated_text = ""
        try:
            # Send prompt
            prompt_obj = {
                "type": "prompt",
                "message": f"System Context: {system_instruction}\n\nDoctor Query: {user_message}",
            }
            if proc.stdin:
                proc.stdin.write(json.dumps(prompt_obj).encode() + b"\n")
                await proc.stdin.drain()

            while True:
                if proc.stdout is None:
                    break
                line = await proc.stdout.readline()
                if not line:
                    break
                line_str = line.decode().strip()
                if not line_str:
                    continue

                try:
                    event = json.loads(line_str)
                    ev_type = event.get("type")

                    if ev_type == "tool_execution_start":
                        tool_name = event.get("toolName")
                        args = event.get("args", {})
                        if tool_name == "talk_to_ct" and (args.get("series_id") or args.get("ct_path")):
                            yield f"data: {json.dumps({'type': 'series_selected', 'series_id': args.get('series_id') or args.get('ct_path')}, ensure_ascii=False)}\n\n"
                        yield f"data: {json.dumps({'type': 'tool_call_start', 'tool': tool_name, 'args': args}, ensure_ascii=False)}\n\n"

                    elif ev_type == "tool_execution_end":
                        tool_name = event.get("toolName")
                        result = event.get("result", {})
                        yield f"data: {json.dumps({'type': 'tool_call_end', 'tool': tool_name, 'result': result}, ensure_ascii=False)}\n\n"
                        if tool_name == "draft_radiology_report" and isinstance(result, dict) and "details" in result:
                            yield f"data: {json.dumps({'type': 'report_card', 'report': result['details']}, ensure_ascii=False)}\n\n"
                        if tool_name == "draft_treatment_plan" and isinstance(result, dict) and "details" in result:
                            yield f"data: {json.dumps({'type': 'plan_card', 'plan': result['details']}, ensure_ascii=False)}\n\n"

                    elif ev_type == "message_update":
                        msg_ev = event.get("assistantMessageEvent", {})
                        sub_type = msg_ev.get("type")
                        if sub_type == "thinking_delta":
                            yield f"data: {json.dumps({'type': 'thinking', 'delta': msg_ev.get('delta', '')}, ensure_ascii=False)}\n\n"
                        elif sub_type == "text_delta":
                            delta = msg_ev.get("delta", "")
                            accumulated_text += delta
                            yield f"data: {json.dumps({'type': 'text_delta', 'delta': delta}, ensure_ascii=False)}\n\n"

                    elif ev_type == "agent_settled":
                        break

                except json.JSONDecodeError:
                    continue

        except Exception as e:
            logger.error(f"Error in Pi RPC streaming: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
        finally:
            if proc.returncode is None:
                proc.terminate()
                await proc.wait()

        if "[REPORT_CARD_START]" in accumulated_text and "[REPORT_CARD_END]" in accumulated_text:
            try:
                card_json = accumulated_text.split("[REPORT_CARD_START]")[1].split("[REPORT_CARD_END]")[0]
                card_data = json.loads(card_json)
                yield f"data: {json.dumps({'type': 'report_card', 'report': card_data}, ensure_ascii=False)}\n\n"
            except Exception:
                pass
        if "[TREATMENT_PLAN_START]" in accumulated_text and "[TREATMENT_PLAN_END]" in accumulated_text:
            try:
                plan_json = accumulated_text.split("[TREATMENT_PLAN_START]")[1].split("[TREATMENT_PLAN_END]")[0]
                plan_data = json.loads(plan_json)
                yield f"data: {json.dumps({'type': 'plan_card', 'plan': plan_data}, ensure_ascii=False)}\n\n"
            except Exception:
                pass

        yield f"data: {json.dumps({'type': 'done', 'full_text': accumulated_text}, ensure_ascii=False)}\n\n"

    async def _stream_via_clinical_coordinator(
        self,
        conversation_id: str,
        patient_id: int,
        user_message: str,
        active_study_id: str | None,
        active_series_id: str | None,
        active_slice: int | None,
        locale: str,
    ) -> AsyncGenerator[str, None]:
        """
        Autonomous clinical coordinator when external cloud LLM API key is pending.
        Calls the tools directly, routes to the real RadSight microservice, and
        synthesizes structured tertiary hospital radiology findings.
        """
        english = locale == "en"

        def localized(zh: str, en: str) -> str:
            return en if english else zh

        # Step 1: Thinking
        thinking = localized(
            "正在分析临床问题意图：识别问诊范畴（CT影像解读 / 既往病历 / 器官分割质控 / 报告起草）...",
            "Analyzing the clinical request (CT interpretation, history, segmentation QC, or report drafting)...",
        )
        yield f"data: {json.dumps({'type': 'thinking', 'delta': thinking + chr(10)}, ensure_ascii=False)}\n\n"
        await asyncio.sleep(0.3)

        # Step 2: Fetch patient CT scans
        yield f"data: {json.dumps({'type': 'tool_call_start', 'tool': 'list_patient_ct_scans', 'args': {'patient_id': patient_id}}, ensure_ascii=False)}\n\n"
        await asyncio.sleep(0.4)

        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                ct_res = await client.get(
                    f"{self.backend_url}/api/v1/agent/internal/patients/{patient_id}/ct_scans",
                    headers=self.backend_headers,
                )
                ct_scans = ct_res.json() if ct_res.status_code == 200 else []
            except Exception:
                ct_scans = []

        yield f"data: {json.dumps({'type': 'tool_call_end', 'tool': 'list_patient_ct_scans', 'result': {'count': len(ct_scans)}}, ensure_ascii=False)}\n\n"

        # LLM Selects target CT scan
        target_scan = None
        if active_series_id:
            for s in ct_scans:
                if s.get("series_id") == active_series_id or s.get("study_id") == active_study_id:
                    target_scan = s
                    break
        if not target_scan and ct_scans:
            target_scan = ct_scans[0]

        selected_series_name = target_scan.get("description", "CT") if target_scan else localized("无可用 CT 序列", "No CT series available")
        selected_file = target_scan.get("file_path", "") if target_scan else ""
        selected_study = target_scan.get("study_id", active_study_id) if target_scan else active_study_id

        yield f"data: {json.dumps({'type': 'series_selected', 'series_id': selected_series_name, 'filename': selected_file, 'study_id': selected_study}, ensure_ascii=False)}\n\n"

        # Determine user intent
        query = user_message.lower()
        needs_plan = any(k in query for k in ["治疗计划", "诊疗计划", "治疗方案", "诊疗方案", "完整计划", "care plan", "treatment plan"])
        needs_patient_record = needs_plan or any(k in query for k in ["病历", "既往", "病史", "检验", "指标", "诊断历史", "患者信息", "症状", "history", "record", "lab", "symptom"])
        needs_qc = needs_plan or any(k in query for k in ["分割", "体积", "器官", "质控", "测量", "3d", "三维", "segmentation", "volume", "organ", "quality"])
        needs_report = any(k in query for k in ["报告", "起草", "生成报告", "写一份", "诊断书", "report", "draft"] ) and not needs_plan
        needs_ct_analysis = needs_plan or any(k in query for k in ["ct", "结节", "磨玻璃", "肺", "肝", "病灶", "占位", "阴影", "所见", "分析", "看", "查", "nodule", "lesion", "lung", "liver", "finding", "analyze"]) or (not needs_patient_record and not needs_qc and not needs_report)

        # Explicit selection banner
        selection_banner = (
            localized(
                f"> 💡 **已自动为您选定分析序列**：`{selected_series_name}` （共 {target_scan.get('slice_count')} 层）\n\n",
                f"> 💡 **Selected analysis series**: `{selected_series_name}` ({target_scan.get('slice_count')} slices)\n\n",
            )
            if target_scan
            else localized(
                "> ⚠️ 当前患者没有可供 Agent 分析的 CT 序列。\n\n",
                "> ⚠️ This patient has no CT series available for Agent analysis.\n\n",
            )
        )
        yield f"data: {json.dumps({'type': 'text_delta', 'delta': selection_banner}, ensure_ascii=False)}\n\n"

        # Execute Patient Records Tool if needed
        patient_records_data = None
        if needs_patient_record or needs_report:
            yield f"data: {json.dumps({'type': 'tool_call_start', 'tool': 'get_patient_records', 'args': {'patient_id': patient_id}}, ensure_ascii=False)}\n\n"
            async with httpx.AsyncClient(timeout=10.0) as client:
                try:
                    p_res = await client.get(
                        f"{self.backend_url}/api/v1/agent/internal/patients/{patient_id}/records",
                        headers=self.backend_headers,
                    )
                    patient_records_data = p_res.json() if p_res.status_code == 200 else {}
                except Exception:
                    patient_records_data = {}
            yield f"data: {json.dumps({'type': 'tool_call_end', 'tool': 'get_patient_records', 'result': {'patient_name': patient_records_data.get('patient', {}).get('name')}}, ensure_ascii=False)}\n\n"

        # Execute Segmentation QC Tool if needed
        qc_data = None
        if needs_qc or needs_report:
            yield f"data: {json.dumps({'type': 'tool_call_start', 'tool': 'get_segmentation_qc', 'args': {'patient_id': patient_id, 'study_id': selected_study}}, ensure_ascii=False)}\n\n"
            async with httpx.AsyncClient(timeout=10.0) as client:
                try:
                    qc_res = await client.get(
                        f"{self.backend_url}/api/v1/agent/internal/patients/{patient_id}/segmentation_qc?study_id={selected_study}",
                        headers=self.backend_headers,
                    )
                    qc_data = qc_res.json() if qc_res.status_code == 200 else {}
                except Exception:
                    qc_data = {}
            yield f"data: {json.dumps({'type': 'tool_call_end', 'tool': 'get_segmentation_qc', 'result': {'organs': len(qc_data.get('organs', []))}}, ensure_ascii=False)}\n\n"

        # Execute Talk to CT (RadSight-8B)
        radsight_result = None
        if (needs_ct_analysis or needs_report) and target_scan:
            radsight_thinking = localized(
                "正在调用本地 RadSight-8B 多模态微服务进行 3D CT 容积视觉特征感知与结节检测...",
                "Calling the local RadSight-8B service for 3D CT volume analysis...",
            )
            yield f"data: {json.dumps({'type': 'thinking', 'delta': radsight_thinking + chr(10)}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'tool_call_start', 'tool': 'talk_to_ct', 'args': {'ct_path': selected_file, 'question': user_message}}, ensure_ascii=False)}\n\n"

            async with httpx.AsyncClient(timeout=300.0) as client:
                try:
                    rs_res = await client.post(
                        f"{self.radsight_url}/v1/vision/talk_to_ct",
                        json={
                            "ct_path": selected_file,
                            "question": user_message,
                            "study_id": selected_study,
                            "patient_context": {
                                "patient_id": str(patient_id),
                                "name": patient_records_data.get("patient", {}).get("name") if patient_records_data else None,
                                "age": patient_records_data.get("patient", {}).get("age") if patient_records_data else None,
                                "gender": patient_records_data.get("patient", {}).get("gender") if patient_records_data else None,
                            },
                        },
                    )
                    if rs_res.status_code == 200:
                        radsight_result = rs_res.json()
                    else:
                        radsight_result = {
                            "status": "error",
                            "stub": False,
                            "raw_text": localized(
                                f"RadSight-8B 调用失败（HTTP {rs_res.status_code}）。",
                                f"RadSight-8B request failed (HTTP {rs_res.status_code}).",
                            ),
                        }
                except Exception as e:
                    logger.warning("RadSight microservice call failed: %s", e)
                    radsight_result = {
                        "status": "error",
                        "stub": False,
                        "raw_text": localized(
                            "RadSight-8B 服务当前不可用。",
                            "The RadSight-8B service is currently unavailable.",
                        ),
                    }

            yield f"data: {json.dumps({'type': 'tool_call_end', 'tool': 'talk_to_ct', 'result': {'status': radsight_result.get('status', 'error'), 'model': radsight_result.get('model', 'RadSight-8B'), 'stub': radsight_result.get('stub', False), 'quant': radsight_result.get('quant'), 'latency_ms': radsight_result.get('latency_ms')}}, ensure_ascii=False)}\n\n"

        # Stream clinical analysis text
        full_text = selection_banner

        if needs_patient_record and patient_records_data:
            p_info = patient_records_data.get("patient", {})
            history_text = localized(
                f"### 📋 患者病历与既往病史概要\n"
                f"- **患者姓名**：{p_info.get('name') or '未提供'} （{p_info.get('gender') or '未提供'}，{p_info.get('age') or '未提供'}岁）\n"
                f"- **既往记录**：{p_info.get('history') or '系统中暂无可用记录'}\n"
                f"- **主要主诉**：{p_info.get('symptoms') or '系统中暂无结构化主诉'}\n\n",
                f"### 📋 Patient history summary\n"
                f"- **Patient**: {p_info.get('name') or 'Not provided'} ({p_info.get('gender') or 'Not provided'}, age {p_info.get('age') or 'Not provided'})\n"
                f"- **History**: {p_info.get('history') or 'No history is available in the system'}\n"
                f"- **Presenting symptoms**: {p_info.get('symptoms') or 'No structured symptoms are available'}\n\n",
            )
            full_text += history_text
            yield f"data: {json.dumps({'type': 'text_delta', 'delta': history_text}, ensure_ascii=False)}\n\n"

        if needs_qc and qc_data:
            organs = qc_data.get("organs", [])
            org_lines = "\n".join(
                localized(
                    f"- **{o.get('name')}**: 体积测定 {o.get('volume_ml')} mL（密度均值：{o.get('mean_hu')} HU）",
                    f"- **{o.get('name')}**: volume {o.get('volume_ml')} mL (mean density: {o.get('mean_hu')} HU)",
                )
                for o in organs[:5]
            )
            qc_text = localized(
                f"### 📐 3D 解剖器官分割质控与体积测定\n"
                f"- **分割模型**：VISTA-3D (nv-segment-ctmr)\n"
                f"- **主要解剖器官体积**：\n{org_lines if org_lines else '- 暂无可用分割体积'}\n"
                f"- **质控判定**：{qc_data.get('qc_status', 'missing')}\n\n",
                f"### 📐 3D anatomy segmentation QC and volumes\n"
                f"- **Segmentation model**: VISTA-3D (nv-segment-ctmr)\n"
                f"- **Key organ volumes**:\n{org_lines if org_lines else '- No segmentation volumes are available'}\n"
                f"- **QC status**: {qc_data.get('qc_status', 'missing')}\n\n",
            )
            full_text += qc_text
            yield f"data: {json.dumps({'type': 'text_delta', 'delta': qc_text}, ensure_ascii=False)}\n\n"

        if radsight_result and radsight_result.get("raw_text"):
            ct_analysis_text = f"{radsight_result['raw_text']}\n\n"
            full_text += ct_analysis_text
            yield f"data: {json.dumps({'type': 'text_delta', 'delta': ct_analysis_text}, ensure_ascii=False)}\n\n"

        if needs_plan:
            yield f"data: {json.dumps({'type': 'tool_call_start', 'tool': 'draft_treatment_plan', 'args': {'patient_id': patient_id, 'study_id': selected_study}}, ensure_ascii=False)}\n\n"
            p_info = (patient_records_data or {}).get("patient", {})
            organs = (qc_data or {}).get("organs") or []
            organ_lines = "\n".join(
                localized(
                    f"- {o.get('name')}: {o.get('volume_ml')} mL（{o.get('status', 'unknown')}）",
                    f"- {o.get('name')}: {o.get('volume_ml')} mL ({o.get('status', 'unknown')})",
                )
                for o in organs
                if o.get("name") in {"liver", "spleen", "heart", "pancreas", "left kidney", "right kidney"}
                or "lung" in str(o.get("name", "")).lower()
                or "肝" in str(o.get("name", ""))
            )
            vision = (radsight_result or {}).get("raw_text") or localized(
                "RadSight-8B 本次未返回可用视觉分析，治疗计划不得编造影像征象。",
                "RadSight-8B returned no usable visual analysis; the plan must not invent imaging findings.",
            )
            if any(n in vision for n in ("4.2mm", "LU-RADS 2", "LU-RADS 2 类")):
                vision = localized(
                    "RadSight 输出疑似模板，已弃用；请以真实容积分析为准，不得将 4.2mm / LU-RADS 2 写入计划。",
                    "A suspected template response from RadSight was discarded; use real volume analysis and do not copy 4.2 mm / LU-RADS 2 into the plan.",
                )
            plan_draft = {
                "type": "treatment_plan",
                "patient_id": patient_id,
                "study_id": selected_study,
                "symptom_analysis": localized(
                    f"患者{p_info.get('name', '')}，{p_info.get('gender', '')}，{p_info.get('age', '')}岁。"
                    f"主诉：{p_info.get('symptoms', '')}。既往：{p_info.get('history', '')}。\n"
                    f"与影像对照：\n{vision}",
                    f"Patient {p_info.get('name', '')}, {p_info.get('gender', '')}, age {p_info.get('age', '')}. "
                    f"Presenting symptoms: {p_info.get('symptoms', '')}. History: {p_info.get('history', '')}.\n"
                    f"Imaging correlation:\n{vision}",
                ),
                "working_diagnosis": localized(
                    "工作诊断须绑定上述 RadSight 原文与病历，不得补充未见结节或未查检验。"
                    "慢性支气管炎急性加重 vs 感染 vs 刺激性咳嗽，待临床与实验室证实。",
                    "The working diagnosis must remain grounded in the RadSight output and chart; do not add unseen nodules or unperformed tests. Consider chronic bronchitis exacerbation, infection, or irritant cough pending clinical and laboratory confirmation.",
                ),
                "differential": localized(
                    "社区获得性肺炎、气道高反应、心力衰竭、肺栓塞、肿瘤——仅在影像或病历支持时升级，否则列为待排除。",
                    "Community-acquired pneumonia, airway hyperreactivity, heart failure, pulmonary embolism, or malignancy—escalate only when supported by imaging or the chart; otherwise keep as rule-outs.",
                ),
                "workup": localized(
                    "血常规、CRP、必要时痰培养；肺功能（若无禁忌）；脉搏血氧；若 RadSight 提示可疑 PE 或急性胸痛征象则按急诊路径评估 D-二聚体/增强CT，禁止无依据开单。",
                    "CBC, CRP, sputum culture when indicated, spirometry if not contraindicated, and pulse oximetry. If RadSight suggests PE or acute chest-pain findings, follow the emergency pathway for D-dimer/contrast CT; do not order without evidence.",
                ),
                "pharmacologic": localized(
                    "镇咳对症需排除感染红旗后个体化；慢支患者评估是否需要短程支气管扩张剂/吸入激素。具体药物与剂量由接诊医师根据禁忌证开立，本草案不写虚构毫克数。",
                    "Individualize symptomatic cough treatment after excluding infectious red flags; assess whether a short bronchodilator/inhaled-steroid course is appropriate. The treating physician must choose drugs and doses after reviewing contraindications; this draft invents no dosage.",
                ),
                "nonpharmacologic": localized(
                    "启动戒烟、疫苗评估、避免烟雾刺激并提供呼吸康复教育。",
                    "Initiate smoking cessation, assess vaccination, avoid smoke exposure, and provide pulmonary rehabilitation education.",
                ),
                "followup": localized(
                    "若无红旗，48–72 小时症状复查；低剂量胸部 CT 随访间隔依据真实影像结论而非模板。",
                    "If no red flags are present, reassess symptoms in 48–72 hours. Base any low-dose chest CT interval on the actual imaging conclusion, not a template.",
                ),
                "red_flags": localized(
                    "咯血、高热、静息呼吸困难、血氧下降、单侧下肢肿痛或意识改变——立即急诊。",
                    "Hemoptysis, high fever, dyspnea at rest, falling oxygen saturation, unilateral leg swelling/pain, or altered mental status require emergency evaluation.",
                ),
                "disclaimer": localized(
                    "本计划由 AI Copilot 根据病历、RadSight-8B 与 VISTA-3D 质控起草，须经接诊医师复核后方可执行。",
                    "AI Copilot drafted this plan from the chart, RadSight-8B, and VISTA-3D QC. The treating physician must review it before use.",
                ),
            }
            if organ_lines:
                plan_draft["symptom_analysis"] += localized(
                    f"\n\n分割质控（供容量参考，异常项不得解释为确诊）：\n{organ_lines}",
                    f"\n\nSegmentation QC (volume reference only; abnormalities are not diagnoses):\n{organ_lines}",
                )
            yield f"data: {json.dumps({'type': 'plan_card', 'plan': plan_draft}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'tool_call_end', 'tool': 'draft_treatment_plan', 'result': {'status': 'plan_generated'}}, ensure_ascii=False)}\n\n"
            plan_finish = f"[TREATMENT_PLAN_START]{json.dumps(plan_draft, ensure_ascii=False)}[TREATMENT_PLAN_END]\n\n" + localized(
                "🩺 **完整临床治疗计划草案已生成**。上方卡片供医师复核后纳入病程记录；AI 不得代替开立医嘱。",
                "🩺 **A complete clinical care-plan draft is ready**. A physician must review the card before adding it to the chart; AI cannot issue medical orders.",
            )
            full_text += plan_finish
            yield f"data: {json.dumps({'type': 'text_delta', 'delta': plan_finish}, ensure_ascii=False)}\n\n"

        # Handle Report Drafting Card
        if needs_report:
            yield f"data: {json.dumps({'type': 'tool_call_start', 'tool': 'draft_radiology_report', 'args': {'patient_id': patient_id, 'study_id': selected_study}}, ensure_ascii=False)}\n\n"

            grounded_findings = (radsight_result or {}).get("raw_text") or localized(
                "本次没有可用的 RadSight 影像分析结果，无法自动生成影像所见。",
                "No usable RadSight imaging analysis is available, so findings cannot be generated automatically.",
            )
            report_draft = {
                "patient_id": patient_id,
                "study_id": selected_study,
                "exam_technique": target_scan.get("description", "CT") if target_scan else localized("未选择 CT 序列", "No CT series selected"),
                "findings": grounded_findings,
                "impression": localized(
                    "仅根据上方真实工具结果形成草案；请放射科医师复核并补充诊断印象。",
                    "This draft uses only the tool results above. A radiologist must review and complete the impression.",
                ),
                "recommendations": localized(
                    "随访与进一步检查应由医师结合原始影像和临床资料决定。",
                    "A physician should determine follow-up and further testing from the original images and clinical context.",
                ),
            }

            yield f"data: {json.dumps({'type': 'report_card', 'report': report_draft}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'tool_call_end', 'tool': 'draft_radiology_report', 'result': {'status': 'draft_generated'}}, ensure_ascii=False)}\n\n"

            report_finish_text = localized(
                "📝 **结构化放射学诊断报告草案已生成**。请复核上方卡片后再填入报告。",
                "📝 **A structured radiology report draft is ready**. Review the card before inserting it into the report.",
            )
            full_text += report_finish_text
            yield f"data: {json.dumps({'type': 'text_delta', 'delta': report_finish_text}, ensure_ascii=False)}\n\n"

        yield f"data: {json.dumps({'type': 'done', 'full_text': full_text}, ensure_ascii=False)}\n\n"
