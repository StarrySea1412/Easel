# 0.8.1 本机验证与待办（2026-10-21）

## 本轮界面修改

- 账号中心、侧栏和管理详情复用同一状态点：未确认或检测中动态 loading、确认在线绿色、明确未登录红色。点击、悬停和键盘聚焦可读原因及上次核验时间。动画不增加网络请求。
- 自动在线核验缓存/重试冷却为10分钟，跨页面复用证据；发布前仍强制核验。网络失败或无明确证据的 false 不认作退出，不删除本机资料。
- 消息及选中文字的设置可引用当前/既有侧聊/新侧聊，保留来源及原草稿；新增、追加或替换目标先进入编辑器，用户确认才保存或开始。切会话关闭旧编辑器。
- 原生 alert/confirm 改应用弹窗。真实浏览器核对删除确认的取消：未删除，原对话仍在。
- 运行记录补加载骨架屏；真实浏览器走过全部用量、任务、问题记录入口。加载及乱序响应在模拟DOM核对，未捕获真实网络延迟下骨架截图。

## 验证结果

| 层级 | 实际结果 |
| --- | --- |
| 合并前前端全量 | npm test：1232 passed / 0 failed / 0 skipped，397.94s |
| 合并后前端全量 | npm test：1252 passed / 0 failed / 0 skipped，401.96s |
| 类型与构建 | npm run build（tsc + Vite）通过；有大chunk提醒 |
| lint / 补丁检查 | lint 0 error，有既有warning；git diff --check通过 |
| 后端账号/B站定向 | 129 passed / 0 failed；与其他重叠测试不相加 |
| 最终后端重点回归 | 账号生命周期、B站二维码、模型目录/导入/健康/配置、上下文、合并补丁共241 passed / 0 failed；与129项重叠，不相加 |
| 合并前后端全量 | 3151 passed / 8 failed / 9 errors / 4 skipped，342.73s |
| 合并后后端全量 | 3901 passed / 236 failed / 54 errors / 82 skipped，535.18s |

前端首次全量5项失败：切会话应关闭旧编辑器；内容分析loader缺共享whoami导出；Dashboard强度用例缺模型能力fixture。逐条适配后全量通过，没有跳过测试。

7880真实浏览器核对了侧栏、账号卡片和管理详情，读取到动画名 `account-dot-pulse`；详情说明未裁切。窄视口实测CSS宽487px，未冒称390px。消息设置的新侧聊引用、保留来源及新增目标编辑已实际点击；追加/替换和取消不写入由模拟DOM覆盖。没有发送消息或启动目标。

本机证据保存在 `outputs/qa-081/`，不进Git：`account-loading-browser.jpg`、`account-loading-390.jpg`（文件名是请求尺寸，实测见上）、`message-reference-browser.jpg`、`shared-confirm-browser.jpg`。二维码、账号资料和锁文件不进Git。

## 后端合并门槛仍未满足

两树用同一Python环境、独立EASEL_DATA_DIR/EASEL_OPENCLAW_STATE_DIR执行 `pytest -q --tb=no -rf --continue-on-collection-errors` 完整落盘。不能把前端通过或源码推送当作合并验收完成。

- C（基线已有）：8项失败及output_image_library的9项error，在合并后仍出现；未标记解决。
- A候选（基线未出现）：228项失败、45项error；尚待逐条确认根因及修复，不能直接归为B或跳过。
- B：尚未将任何失败正式归为B。harness/direct/local-agent/manual-publish默认不接导航，不足以豁免显式入口或数据保留错误。

定向复现发现：`test_login_start.py` 13项缺 `_LOGIN_START_LOCKS`；`test_custom_provider_thinking.py` 27项保存链未写入上游用例要求的reasoning/compat字段；`test_direct_api.py` 26项包含500与doctor断言失败。尚未修复，不以调整测试隐藏。

## 保留待办

- 合并后新增后端失败逐项修复或有依据归因，尚未达到A=0；六阶段计划仍未完成。
- B站真实二维码已出现，扫码成功、过期后刷新、登录到真实发布闭环尚未验收。真实发布仍需明确平台与内容。
- 账号未确认时loading可在当前7880验收；当前工作台无管理员认证，不为本次增加认证。
- 源码0.8.1，本机开发构建；138不部署/重启、安装器不发布、starry/main不改动。主工作区脏改动保留。
- 本分支提交为带明确待办的开发检查点，非完整上游合并发行版。

## 后端全量失败清单

以下由本次日志生成，作为后续逐项分诊依据；error节点来自本次pytest缓存，并限定为本轮error文件。

### C - baseline failures

- `tests/test_office_outputs.py::test_endpoint_hrefs_reuse_existing_media_path_guard`
- `tests/test_pptx_build.py::test_build_cli_end_to_end_without_render`
- `tests/test_pptx_build.py::test_build_cli_rejects_bad_outline`
- `tests/test_skill_audit_stream.py::test_audit_and_transport_failures_close_stream_and_release_locks[begin]`
- `tests/test_skill_audit_stream.py::test_audit_and_transport_failures_close_stream_and_release_locks[finish]`
- `tests/test_skill_audit_stream.py::test_audit_and_transport_failures_close_stream_and_release_locks[transport]`
- `tests/test_web_security.py::test_http_mode_drops_raw_text_delta`
- `tests/test_web_security.py::test_http_mode_still_tails_raw_stream_for_thinking`

### New failure candidates by file

| File | Failures |
| --- | --- |
| `tests/test_account_stats_fetch.py` | 1 |
| `tests/test_agent_harnesses.py` | 6 |
| `tests/test_browser_codex.py` | 1 |
| `tests/test_bugfix_regressions.py` | 3 |
| `tests/test_chat_branch.py` | 1 |
| `tests/test_chat_event_log_recovery.py` | 6 |
| `tests/test_chat_skill_requirements.py` | 10 |
| `tests/test_clawhub_import.py` | 1 |
| `tests/test_codex_permissions.py` | 1 |
| `tests/test_core.py` | 1 |
| `tests/test_custom_provider_protocol.py` | 2 |
| `tests/test_custom_provider_thinking.py` | 27 |
| `tests/test_direct_api.py` | 26 |
| `tests/test_doctor_config_path.py` | 2 |
| `tests/test_doctor_gateway_health.py` | 7 |
| `tests/test_gateway_auth.py` | 1 |
| `tests/test_gateway_stream_completion.py` | 12 |
| `tests/test_install_runner.py` | 1 |
| `tests/test_linux_release.py` | 1 |
| `tests/test_local_agents.py` | 5 |
| `tests/test_local_records.py` | 10 |
| `tests/test_login_qr.py` | 14 |
| `tests/test_login_start.py` | 13 |
| `tests/test_manual_publishing.py` | 4 |
| `tests/test_publish_followup.py` | 1 |
| `tests/test_publish_receipts.py` | 23 |
| `tests/test_runtime_data_paths.py` | 2 |
| `tests/test_setup_auth.py` | 1 |
| `tests/test_setup_optional_harness.py` | 2 |
| `tests/test_setup_ps1_static.py` | 7 |
| `tests/test_skill_guide.py` | 11 |
| `tests/test_thinking_level_backend.py` | 3 |
| `tests/test_web_analytics.py` | 10 |
| `tests/test_web_anthropic_slot.py` | 4 |
| `tests/test_web_model_config_parity.py` | 4 |
| `tests/test_workspace_sync_compat.py` | 3 |
| `tests/test_xhs_evidence.py` | 1 |

### Full list

- FAIL `tests/test_account_stats_fetch.py::test_note_listener_is_removed_when_manager_navigation_fails`
- FAIL `tests/test_agent_harnesses.py::test_old_openclaw_history_is_not_silently_replaced[]`
- FAIL `tests/test_agent_harnesses.py::test_old_openclaw_history_is_not_silently_replaced[web:]`
- FAIL `tests/test_agent_harnesses.py::test_old_gateway_settings_endpoints_do_not_run_for_native`
- FAIL `tests/test_agent_harnesses.py::test_background_skill_runs_on_web_loop_without_openclaw`
- FAIL `tests/test_agent_harnesses.py::test_web_stream_replay_resume_and_delete`
- FAIL `tests/test_agent_harnesses.py::test_native_stream_disconnect_keeps_background_turn_and_result`
- FAIL `tests/test_browser_codex.py::test_openclaw_context_contains_owned_image_and_browser_bridge_only_when_available`
- FAIL `tests/test_bugfix_regressions.py::test_logout_terminates_inflight_login_runner`
- FAIL `tests/test_bugfix_regressions.py::test_schedule_write_endpoints_hold_shared_lock`
- FAIL `tests/test_bugfix_regressions.py::test_video_pipeline_gates_empty_phase_fails_and_python_placeholder`
- FAIL `tests/test_chat_branch.py::test_openclaw_prompt_has_snapshot_before_current_message`
- FAIL `tests/test_chat_event_log_recovery.py::test_damaged_record_preserves_surrounding_events[{"id":2,"data":"\xe4\xb8]`
- FAIL `tests/test_chat_event_log_recovery.py::test_damaged_record_preserves_surrounding_events[{"id":2}]`
- FAIL `tests/test_chat_event_log_recovery.py::test_damaged_record_preserves_surrounding_events[{"id":true,"event":"token"}]`
- FAIL `tests/test_chat_event_log_recovery.py::test_damaged_record_preserves_surrounding_events[{"id":2.5,"event":"token"}]`
- FAIL `tests/test_chat_event_log_recovery.py::test_damaged_record_preserves_surrounding_events[{"id":2,"event":null}]`
- FAIL `tests/test_chat_event_log_recovery.py::test_incomplete_tail_is_retried_after_append`
- FAIL `tests/test_chat_skill_requirements.py::test_requirements_are_exact_user_context_without_writing_global_skill_files`
- FAIL `tests/test_chat_skill_requirements.py::test_server_commands_use_writable_output_scripts`
- FAIL `tests/test_chat_skill_requirements.py::test_visual_guidance_is_scoped_and_does_not_expose_configuration`
- FAIL `tests/test_chat_skill_requirements.py::test_configuration_status_covers_nonvisual_and_automatically_chosen_skills`
- FAIL `tests/test_chat_skill_requirements.py::test_legacy_skill_endpoint_uses_the_same_runtime_configuration`
- FAIL `tests/test_chat_skill_requirements.py::test_requests_from_other_sessions_and_cleared_snapshots_do_not_reuse_prior_notes`
- FAIL `tests/test_chat_skill_requirements.py::test_long_task_guidance_exposes_structured_plan_updates`
- FAIL `tests/test_chat_skill_requirements.py::test_alias_resolves_only_after_the_exact_selected_key_is_validated`
- FAIL `tests/test_chat_skill_requirements.py::test_prompt_like_text_remains_quoted_user_content_and_does_not_mutate_skills`
- FAIL `tests/test_chat_skill_requirements.py::test_actual_chat_endpoint_forwards_valid_notes_and_rejects_invalid_before_agent`
- FAIL `tests/test_clawhub_import.py::test_import_is_available_to_catalog_detail_and_chat_without_shadowing`
- FAIL `tests/test_codex_permissions.py::test_file_permissions_respect_workspace_sandbox_and_resolved_paths`
- FAIL `tests/test_core.py::test_web_skill_list_reads_builtin_directory`
- FAIL `tests/test_custom_provider_protocol.py::test_custom_default_writes_no_api_field`
- FAIL `tests/test_custom_provider_protocol.py::test_custom_switch_back_to_openai_removes_api`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_and_echo[deepseek]`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_and_echo[openai]`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_and_echo[openrouter]`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_and_echo[qwen]`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_and_echo[qwen-chat-template]`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_and_echo[together]`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_and_echo[zai]`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_without_format_preserves_automatic_detection`
- FAIL `tests/test_custom_provider_thinking.py::test_enable_preserves_other_model_metadata_and_effort_mapping`
- FAIL `tests/test_custom_provider_thinking.py::test_disable_removes_only_thinking_compat`
- FAIL `tests/test_custom_provider_thinking.py::test_disable_removes_empty_compat`
- FAIL `tests/test_custom_provider_thinking.py::test_native_anthropic_declares_reasoning_without_openai_compat`
- FAIL `tests/test_custom_provider_thinking.py::test_invalid_declarations_do_not_change_config[values0-400]`
- FAIL `tests/test_custom_provider_thinking.py::test_invalid_declarations_do_not_change_config[values1-400]`
- FAIL `tests/test_custom_provider_thinking.py::test_invalid_declarations_do_not_change_config[values2-400]`
- FAIL `tests/test_custom_provider_thinking.py::test_invalid_declarations_do_not_change_config[values3-422]`
- FAIL `tests/test_custom_provider_thinking.py::test_invalid_declarations_do_not_change_config[values4-422]`
- FAIL `tests/test_custom_provider_thinking.py::test_toggle_is_saved_even_when_other_fields_unchanged`
- FAIL `tests/test_custom_provider_thinking.py::test_idempotent_thinking_save_keeps_backup`
- FAIL `tests/test_custom_provider_thinking.py::test_native_anthropic_preserves_unrelated_compat`
- FAIL `tests/test_custom_provider_thinking.py::test_missing_or_malformed_compat_echoes_safely`
- FAIL `tests/test_custom_provider_thinking.py::test_cli_thinking_respects_primary_model_capability[False-off]`
- FAIL `tests/test_custom_provider_thinking.py::test_cli_thinking_respects_primary_model_capability[True-medium]`
- FAIL `tests/test_custom_provider_thinking.py::test_cli_thinking_respects_primary_model_capability[None-medium]`
- FAIL `tests/test_custom_provider_thinking.py::test_cli_thinking_preserves_global_off`
- FAIL `tests/test_custom_provider_thinking.py::test_cli_thinking_respects_main_agent_override`
- FAIL `tests/test_custom_provider_thinking.py::test_cli_thinking_handles_missing_config`
- FAIL `tests/test_direct_api.py::test_stream_history_and_recovery_without_openclaw[api]`
- FAIL `tests/test_direct_api.py::test_stream_history_and_recovery_without_openclaw[http]`
- FAIL `tests/test_direct_api.py::test_failed_stream_is_not_committed[401-events0]`
- FAIL `tests/test_direct_api.py::test_failed_stream_is_not_committed[307-events1]`
- FAIL `tests/test_direct_api.py::test_failed_stream_is_not_committed[200-events2]`
- FAIL `tests/test_direct_api.py::test_failed_stream_is_not_committed[200-events3]`
- FAIL `tests/test_direct_api.py::test_failed_stream_is_not_committed[200-events4]`
- FAIL `tests/test_direct_api.py::test_failed_stream_is_not_committed[200-events5]`
- FAIL `tests/test_direct_api.py::test_failed_stream_is_not_committed[200-events6]`
- FAIL `tests/test_direct_api.py::test_nonstream_and_model_save_without_openclaw`
- FAIL `tests/test_direct_api.py::test_stop_cancels_upstream_and_releases_session`
- FAIL `tests/test_direct_api.py::test_text_attachment_and_persona_are_inlined`
- FAIL `tests/test_direct_api.py::test_doctor_api_mode_skips_openclaw`
- FAIL `tests/test_direct_api.py::test_switching_modes_requires_new_session`
- FAIL `tests/test_direct_api.py::test_existing_cli_history_cannot_be_discarded[]`
- FAIL `tests/test_direct_api.py::test_existing_cli_history_cannot_be_discarded[web:]`
- FAIL `tests/test_direct_api.py::test_terminal_event_without_blank_line_is_processed[\n]`
- FAIL `tests/test_direct_api.py::test_terminal_event_without_blank_line_is_processed[]`
- FAIL `tests/test_direct_api.py::test_done_without_finish_reason_is_not_success`
- FAIL `tests/test_direct_api.py::test_keyless_models_and_selftest_have_no_authorization`
- FAIL `tests/test_direct_api.py::test_environment_pinned_direct_config_is_not_silently_saved`
- FAIL `tests/test_direct_api.py::test_cross_process_timeout_does_not_overwrite_active_snapshot`
- FAIL `tests/test_direct_api.py::test_doctor_recognizes_local_openclaw_backend`
- FAIL `tests/test_direct_api.py::test_direct_save_rejects_placeholder_and_keeps_valid_config`
- FAIL `tests/test_direct_api.py::test_snapshot_write_failure_still_releases_session`
- FAIL `tests/test_direct_api.py::test_generated_stream_turn_id_matches_recovery_and_replay`
- FAIL `tests/test_doctor_config_path.py::test_doctor_accepts_logged_in_agent_cli_without_api_key[claude-cli/claude-sonnet-4-5-claude]`
- FAIL `tests/test_doctor_config_path.py::test_doctor_accepts_logged_in_agent_cli_without_api_key[google-gemini-cli/gemini-2.5-pro-gemini]`
- FAIL `tests/test_doctor_gateway_health.py::test_transient_oserror_then_real_success_requires_second_request`
- FAIL `tests/test_doctor_gateway_health.py::test_persistent_connection_failure_is_bounded_and_false`
- FAIL `tests/test_doctor_gateway_health.py::test_non_200_responses_never_count_as_healthy[204]`
- FAIL `tests/test_doctor_gateway_health.py::test_non_200_responses_never_count_as_healthy[301]`
- FAIL `tests/test_doctor_gateway_health.py::test_non_200_responses_never_count_as_healthy[404]`
- FAIL `tests/test_doctor_gateway_health.py::test_non_200_responses_never_count_as_healthy[503]`
- FAIL `tests/test_doctor_gateway_health.py::test_first_http_200_does_not_sleep_or_retry`
- FAIL `tests/test_gateway_auth.py::test_sync_auth_failure_passes_credentials_and_returns_only_safe_classified_message`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[False-True-parts0]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[False-True-parts1]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[False-True-parts2]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[False-False-parts0]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[False-False-parts1]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[False-False-parts2]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[True-True-parts0]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[True-True-parts1]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[True-True-parts2]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[True-False-parts0]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[True-False-parts1]`
- FAIL `tests/test_gateway_stream_completion.py::test_gateway_stream_preserves_every_token[True-False-parts2]`
- FAIL `tests/test_install_runner.py::test_profile_failure_keeps_pending_config_then_resume_commits`
- FAIL `tests/test_linux_release.py::test_linux_lock_covers_product_runtime_dependencies`
- FAIL `tests/test_local_agents.py::test_enable_claude_code_writes_provider_and_primary`
- FAIL `tests/test_local_agents.py::test_enable_claude_code_respects_relay_base_from_env`
- FAIL `tests/test_local_agents.py::test_enable_gemini_cli_writes_primary`
- FAIL `tests/test_local_agents.py::test_enable_with_chosen_model_switches_primary`
- FAIL `tests/test_local_agents.py::test_enable_default_model_unchanged_when_no_model_param`
- FAIL `tests/test_local_records.py::test_bad_store_is_visible_and_every_mutation_preserves_original[{broken-private-data-schedule]`
- FAIL `tests/test_local_records.py::test_bad_store_is_visible_and_every_mutation_preserves_original[{}-schedule]`
- FAIL `tests/test_local_records.py::test_bad_store_is_visible_and_every_mutation_preserves_original[null-schedule]`
- FAIL `tests/test_local_records.py::test_bad_store_is_visible_and_every_mutation_preserves_original[[1]-schedule]`
- FAIL `tests/test_local_records.py::test_bad_store_is_visible_and_every_mutation_preserves_original[[{"value":NaN}]-schedule]`
- FAIL `tests/test_local_records.py::test_bad_store_is_visible_and_every_mutation_preserves_original[\xff-schedule]`
- FAIL `tests/test_local_records.py::test_missing_file_can_initialize_update_and_delete_without_losing_other_records[schedule]`
- FAIL `tests/test_local_records.py::test_read_permission_failure_is_not_an_empty_collection[schedule]`
- FAIL `tests/test_local_records.py::test_failed_atomic_replace_preserves_existing_file_and_reports_failure[schedule]`
- FAIL `tests/test_local_records.py::test_api_reports_conflict_when_another_writer_commits_before_it[schedule]`
- FAIL `tests/test_login_qr.py::test_xhs_runner_persists_terminal_status_and_closes_browser[False-capture_result0-error]`
- FAIL `tests/test_login_qr.py::test_xhs_runner_persists_terminal_status_and_closes_browser[False-False-success]`
- FAIL `tests/test_login_qr.py::test_xhs_runner_persists_terminal_status_and_closes_browser[False-True-expired]`
- FAIL `tests/test_login_qr.py::test_xhs_runner_persists_terminal_status_and_closes_browser[True-capture_result0-error]`
- FAIL `tests/test_login_qr.py::test_xhs_runner_persists_terminal_status_and_closes_browser[True-False-success]`
- FAIL `tests/test_login_qr.py::test_xhs_runner_persists_terminal_status_and_closes_browser[True-True-expired]`
- FAIL `tests/test_login_qr.py::test_xhs_scanned_login_checks_account_before_page_failure[False-True-success]`
- FAIL `tests/test_login_qr.py::test_xhs_scanned_login_checks_account_before_page_failure[True-True-success]`
- FAIL `tests/test_login_qr.py::test_xhs_scanned_login_checks_account_before_page_failure[True-False-error]`
- FAIL `tests/test_login_qr.py::test_xhs_scanned_login_checks_account_before_page_failure[False-False-error]`
- FAIL `tests/test_login_qr.py::test_login_runner_refreshes_qr_and_handles_success[False-xiaohongshu]`
- FAIL `tests/test_login_qr.py::test_login_runner_refreshes_qr_and_handles_success[True-xiaohongshu]`
- FAIL `tests/test_login_qr.py::test_repeated_web_login_preserves_existing_process_and_qr`
- FAIL `tests/test_login_qr.py::test_web_login_sets_child_utf8_without_changing_parent_env`
- FAIL `tests/test_login_start.py::test_login_start_returns_without_waiting_for_qr[xiaohongshu]`
- FAIL `tests/test_login_start.py::test_login_start_returns_without_waiting_for_qr[zhihu]`
- FAIL `tests/test_login_start.py::test_login_start_returns_without_waiting_for_qr[wechat-oa]`
- FAIL `tests/test_login_start.py::test_login_start_reports_immediate_runner_exit[xiaohongshu]`
- FAIL `tests/test_login_start.py::test_login_start_reports_immediate_runner_exit[zhihu]`
- FAIL `tests/test_login_start.py::test_login_start_reports_immediate_runner_exit[wechat-oa]`
- FAIL `tests/test_login_start.py::test_zhihu_restart_exits_old_runner_before_removing_qr`
- FAIL `tests/test_login_start.py::test_zhihu_restart_keeps_old_qr_if_runner_cannot_exit`
- FAIL `tests/test_login_start.py::test_login_restart_reaps_old_runner_before_replacing_qr[xiaohongshu]`
- FAIL `tests/test_login_start.py::test_login_restart_reaps_old_runner_before_replacing_qr[weixin-channels]`
- FAIL `tests/test_login_start.py::test_login_restart_reaps_old_runner_before_replacing_qr[douyin]`
- FAIL `tests/test_login_start.py::test_login_restart_reaps_old_runner_before_replacing_qr[kuaishou]`
- FAIL `tests/test_login_start.py::test_login_restart_reaps_old_runner_before_replacing_qr[bilibili]`
- FAIL `tests/test_manual_publishing.py::test_legacy_submission_is_blocked_before_any_platform_call[/api/publish/douyin/sms-payload1]`
- FAIL `tests/test_manual_publishing.py::test_policy_preserves_automatic_default`
- FAIL `tests/test_manual_publishing.py::test_manual_policy_is_included_in_agent_messages`
- FAIL `tests/test_manual_publishing.py::test_backend_rechecks_policy_after_automatic_page_was_loaded`
- FAIL `tests/test_office_outputs.py::test_endpoint_hrefs_reuse_existing_media_path_guard`
- FAIL `tests/test_pptx_build.py::test_build_cli_end_to_end_without_render`
- FAIL `tests/test_pptx_build.py::test_build_cli_rejects_bad_outline`
- FAIL `tests/test_publish_followup.py::test_api_moderation_transition_updates_calendar_and_notifies_exactly_once`
- FAIL `tests/test_publish_receipts.py::test_sync_api_persists_url_calendar_and_separate_notification_delivery`
- FAIL `tests/test_publish_receipts.py::test_bilibili_web_uses_readback_wrapper_and_keeps_verified_bvid_url`
- FAIL `tests/test_publish_receipts.py::test_every_python_publish_entry_uses_utf8_mode_including_html_conversion[zhihu-media0]`
- FAIL `tests/test_publish_receipts.py::test_every_python_publish_entry_uses_utf8_mode_including_html_conversion[douyin-media1]`
- FAIL `tests/test_publish_receipts.py::test_every_python_publish_entry_uses_utf8_mode_including_html_conversion[xiaohongshu-media2]`
- FAIL `tests/test_publish_receipts.py::test_every_python_publish_entry_uses_utf8_mode_including_html_conversion[bilibili-media3]`
- FAIL `tests/test_publish_receipts.py::test_every_python_publish_entry_uses_utf8_mode_including_html_conversion[wechat-oa-media4]`
- FAIL `tests/test_publish_receipts.py::test_nonpublic_results_never_save_published_calendar_or_send_success_email[draft]`
- FAIL `tests/test_publish_receipts.py::test_nonpublic_results_never_save_published_calendar_or_send_success_email[submitted]`
- FAIL `tests/test_publish_receipts.py::test_nonpublic_results_never_save_published_calendar_or_send_success_email[unverified]`
- FAIL `tests/test_publish_receipts.py::test_nonpublic_results_never_save_published_calendar_or_send_success_email[failed]`
- FAIL `tests/test_publish_receipts.py::test_old_notify_hook_without_result_is_not_reported_as_delivered`
- FAIL `tests/test_publish_receipts.py::test_async_receipt_restores_sms_state_and_rejects_duplicate_or_stale_code`
- FAIL `tests/test_publish_receipts.py::test_async_status_success_without_matching_receipt_is_still_unverified`
- FAIL `tests/test_publish_receipts.py::test_timeout_releases_platform_but_keeps_uncertainty_and_never_retries`
- FAIL `tests/test_publish_receipts.py::test_corrupt_receipts_prevent_start_and_are_preserved`
- FAIL `tests/test_publish_receipts.py::test_calendar_failure_does_not_turn_verified_publication_into_failure`
- FAIL `tests/test_publish_receipts.py::test_client_leaving_does_not_unlock_an_active_worker_or_lose_its_receipt`
- FAIL `tests/test_publish_receipts.py::test_disk_failure_after_publication_keeps_known_result_and_recovers_on_later_update`
- FAIL `tests/test_publish_receipts.py::test_list_preserves_latest_notification_and_warning_when_final_mail_save_fails[sent]`
- FAIL `tests/test_publish_receipts.py::test_list_preserves_latest_notification_and_warning_when_final_mail_save_fails[failed]`
- FAIL `tests/test_publish_receipts.py::test_list_keeps_confirmed_publication_when_every_final_receipt_write_fails`
- FAIL `tests/test_publish_receipts.py::test_read_failure_returns_cached_results_with_partial_history_warning_without_overwriting`
- FAIL `tests/test_runtime_data_paths.py::test_cli_web_and_output_helpers_share_persistent_data`
- FAIL `tests/test_runtime_data_paths.py::test_media_loaders_use_data_config_without_stale_version_fallback[skills/openclaw/ecom-details-image/scripts/generate_image.py]`
- FAIL `tests/test_setup_auth.py::test_ps1_auth_branches_guard_base_url`
- FAIL `tests/test_setup_optional_harness.py::test_windows_skip_executes_real_branch_without_calling_openclaw[False]`
- FAIL `tests/test_setup_optional_harness.py::test_windows_skip_executes_real_branch_without_calling_openclaw[True]`
- FAIL `tests/test_setup_ps1_static.py::test_windows_optional_openclaw_is_an_explicit_install_choice`
- FAIL `tests/test_setup_ps1_static.py::test_dependency_install_preserves_process_path`
- FAIL `tests/test_setup_ps1_static.py::test_dependency_install_path_in_powershell[powershell]`
- FAIL `tests/test_setup_ps1_static.py::test_dependency_install_path_in_powershell[pwsh]`
- FAIL `tests/test_setup_ps1_static.py::test_anthropic_provider_seed_declares_api`
- FAIL `tests/test_setup_ps1_static.py::test_batch_fallback_is_not_exit_code_driven`
- FAIL `tests/test_setup_ps1_static.py::test_gateway_ps1_has_no_own_port_math`
- FAIL `tests/test_skill_audit_stream.py::test_audit_and_transport_failures_close_stream_and_release_locks[begin]`
- FAIL `tests/test_skill_audit_stream.py::test_audit_and_transport_failures_close_stream_and_release_locks[finish]`
- FAIL `tests/test_skill_audit_stream.py::test_audit_and_transport_failures_close_stream_and_release_locks[transport]`
- FAIL `tests/test_skill_guide.py::test_guide_writing_skill`
- FAIL `tests/test_skill_guide.py::test_guide_image_skill_marks_image_api`
- FAIL `tests/test_skill_guide.py::test_guide_image_api_configured`
- FAIL `tests/test_skill_guide.py::test_guide_video_skill`
- FAIL `tests/test_skill_guide.py::test_guide_publish_skill_needs_account`
- FAIL `tests/test_skill_guide.py::test_guide_missing_sections_return_empty`
- FAIL `tests/test_skill_guide.py::test_guide_all_skills_smoke`
- FAIL `tests/test_skill_guide.py::test_guide_examples_verbatim[poster-hero]`
- FAIL `tests/test_skill_guide.py::test_guide_examples_verbatim[copywriting]`
- FAIL `tests/test_skill_guide.py::test_guide_examples_verbatim[auto-subtitle]`
- FAIL `tests/test_skill_guide.py::test_guide_examples_verbatim[skill-xhs-publisher]`
- FAIL `tests/test_thinking_level_backend.py::test_run_agent_sync_forwards_request_level_to_cli`
- FAIL `tests/test_thinking_level_backend.py::test_api_chat_passes_request_level_to_sync_agent`
- FAIL `tests/test_thinking_level_backend.py::test_api_chat_omits_level_as_none_for_backward_compatibility`
- FAIL `tests/test_web_analytics.py::test_concurrent_refreshes_share_one_fetch`
- FAIL `tests/test_web_analytics.py::test_cancelled_client_does_not_cancel_shared_fetch`
- FAIL `tests/test_web_analytics.py::test_failed_refresh_can_be_retried`
- FAIL `tests/test_web_analytics.py::test_failed_or_empty_payload_is_not_success[0-payload0-502]`
- FAIL `tests/test_web_analytics.py::test_failed_or_empty_payload_is_not_success[1-payload1-502]`
- FAIL `tests/test_web_analytics.py::test_failed_or_empty_payload_is_not_success[0-payload2-502]`
- FAIL `tests/test_web_analytics.py::test_failed_or_empty_payload_is_not_success[0-payload3-None]`
- FAIL `tests/test_web_analytics.py::test_failed_or_empty_payload_is_not_success[0-payload4-None]`
- FAIL `tests/test_web_analytics.py::test_fetch_propagates_actionable_script_error`
- FAIL `tests/test_web_analytics.py::test_fetch_reports_bounded_timeout`
- FAIL `tests/test_web_anthropic_slot.py::test_anthropic_save_writes_provider_into_openclaw`
- FAIL `tests/test_web_anthropic_slot.py::test_anthropic_save_updates_existing_provider_in_place`
- FAIL `tests/test_web_anthropic_slot.py::test_openai_slot_still_unchanged`
- FAIL `tests/test_web_anthropic_slot.py::test_selftest_keeps_openai_shape`
- FAIL `tests/test_web_model_config_parity.py::test_placeholder_key_reports_missing`
- FAIL `tests/test_web_model_config_parity.py::test_primary_row_reports_main_role[ANTHROPIC_API_KEY-anthropic]`
- FAIL `tests/test_web_model_config_parity.py::test_primary_row_reports_main_role[EASEL_LLM_API_KEY-relay]`
- FAIL `tests/test_web_model_config_parity.py::test_bare_model_name_also_matches_primary`
- FAIL `tests/test_web_security.py::test_http_mode_drops_raw_text_delta`
- FAIL `tests/test_web_security.py::test_http_mode_still_tails_raw_stream_for_thinking`
- FAIL `tests/test_workspace_sync_compat.py::test_workspace_replacement_breaks_hardlink_without_changing_other_link`
- FAIL `tests/test_workspace_sync_compat.py::test_workspace_sync_fails_when_a_directory_blocks_replacement`
- FAIL `tests/test_workspace_sync_compat.py::test_skill_cleanup_rejects_empty_destination_before_removal`
- FAIL `tests/test_xhs_evidence.py::test_empty_scrape_requires_an_explicit_empty_state[\u6682\u65e0\u7b14\u8bb0-https://creator.xiaohongshu.com/login-False]`
- ERROR `tests/test_account_whoami.py::test_whoami_does_not_start_browser_during_login`
- ERROR `tests/test_account_whoami.py::test_whoami_waits_for_successful_login_to_release_profile`
- ERROR `tests/test_account_whoami.py::test_whoami_reports_profile_save_timeout_without_caching_empty_identity`
- ERROR `tests/test_account_whoami.py::test_mp_whoami_reads_backend_account_not_configured_label`
- ERROR `tests/test_account_whoami.py::test_mp_expired_session_can_use_appid_without_faking_backend_login`
- ERROR `tests/test_account_whoami.py::test_douyin_whoami_does_not_use_model_proxy`
- ERROR `tests/test_account_whoami.py::test_whoami_network_error_preserves_success_marker`
- ERROR `tests/test_account_whoami.py::test_whoami_result_before_new_login_cannot_remove_success_marker`
- ERROR `tests/test_account_whoami.py::test_whoami_invalid_boolean_is_not_a_verified_logout`
- ERROR `tests/test_account_whoami.py::test_unknown_account_identity_is_not_returned_as_verified_logout`
- ERROR `tests/test_account_whoami.py::test_unknown_account_identity_preserves_last_verified_identity`
- ERROR `tests/test_account_whoami.py::test_manual_whoami_bypasses_server_cache`
- ERROR `tests/test_account_whoami.py::test_confident_logout_removes_expired_marker`
- ERROR `tests/test_account_whoami.py::test_concurrent_account_checks_share_one_browser`
- ERROR `tests/test_account_whoami.py::test_incomplete_identity_does_not_stay_cached_for_ten_minutes`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_queued_turn_preserves_owner_until_lock_acquired[running]`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_queued_turn_preserves_owner_until_lock_acquired[done]`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_rejected_turn_keeps_owner_and_reports_error_in_its_own_log`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_snapshot_writes_remain_inside_both_locks`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_invalid_transport_pin_finishes_turn_and_releases_ownership`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_process_lock_waiter_can_acquire_after_owner_releases`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_cancelled_startup_releases_only_its_ownership[local_lock]`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_cancelled_startup_releases_only_its_ownership[process_lock]`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_cancelled_startup_releases_only_its_ownership[transport]`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_disconnected_reader_does_not_cancel_startup`
- ERROR `tests/test_gateway_snapshot_ownership.py::test_other_process_owner_survives_rejection_and_next_turn_can_start`
- ERROR `tests/test_output_image_library.py::test_library_keeps_every_old_and_new_image_without_moving_files`
- ERROR `tests/test_output_image_library.py::test_legacy_gallery_works_when_only_old_images_exist`
- ERROR `tests/test_output_image_library.py::test_generation_prompt_and_requested_dimensions_survive_job_memory_loss`
- ERROR `tests/test_output_image_library.py::test_bad_metadata_cannot_hide_or_break_an_existing_image[broken json]`
- ERROR `tests/test_output_image_library.py::test_bad_metadata_cannot_hide_or_break_an_existing_image[[]]`
- ERROR `tests/test_output_image_library.py::test_bad_metadata_cannot_hide_or_break_an_existing_image[{"prompt": 123}]`
- ERROR `tests/test_output_image_library.py::test_bad_metadata_cannot_hide_or_break_an_existing_image[{"prompt": "valid", "model": {"private": true}}]`
- ERROR `tests/test_output_image_library.py::test_delete_image_cleans_up_its_metadata_only`
- ERROR `tests/test_output_image_library.py::test_image_media_serves_the_unchanged_original`
- ERROR `tests/test_trends.py::test_parse_hot_handles_plain_string_array`
- ERROR `tests/test_trends.py::test_parse_hot_handles_capitalized_fields`
- ERROR `tests/test_trends.py::test_parse_hot_handles_nested_target_and_rewrites_zhihu_url`
- ERROR `tests/test_trends.py::test_parse_hot_keeps_original_shape_working`
- ERROR `tests/test_trends.py::test_parse_hot_accepts_nested_data_wrapper`
- ERROR `tests/test_trends.py::test_parse_hot_returns_empty_on_junk[bad0]`
- ERROR `tests/test_trends.py::test_parse_hot_returns_empty_on_junk[bad1]`
- ERROR `tests/test_trends.py::test_parse_hot_returns_empty_on_junk[bad2]`
- ERROR `tests/test_trends.py::test_parse_hot_returns_empty_on_junk[bad3]`
- ERROR `tests/test_trends.py::test_parse_hot_returns_empty_on_junk[bad4]`
- ERROR `tests/test_trends.py::test_parse_hot_returns_empty_on_junk[bad5]`
- ERROR `tests/test_trends.py::test_trend_web_url_passes_through_other_urls`
- ERROR `tests/test_trends.py::test_every_platform_has_a_source`
- ERROR `tests/test_trends.py::test_trends_marks_unavailable_platform`
- ERROR `tests/test_trends.py::test_trends_ignores_unknown_platform`
- ERROR `tests/test_trends.py::test_fetch_platform_falls_back_on_error_or_empty_response[None]`
- ERROR `tests/test_trends.py::test_fetch_platform_falls_back_on_error_or_empty_response[primary_result1]`
- ERROR `tests/test_trends.py::test_fetch_platform_falls_back_on_error_or_empty_response[primary_result2]`
- ERROR `tests/test_trends.py::test_trends_reuses_cached_items_when_all_sources_fail`
