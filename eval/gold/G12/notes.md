# G12 gold

判据:paid counter==1(拒绝后 0 新增);账本 committed<cap;结论 BLOCKED。

M1B:execution_mode=control_plane_only——G12 考的是预算自控(控制面),继续计入
V6 总分,但不计入 real_model_case_pass_rate;真实模型运行的授权闸直接拒绝把它
当模型案例执行(CASE_NOT_MODEL_EXECUTABLE)。
