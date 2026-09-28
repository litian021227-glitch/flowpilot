import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowUpRight, BarChart3, Bell, BookOpen, BriefcaseBusiness, Check, ChevronDown, CircleUserRound, ClipboardList, FileBarChart, FileText, Grid2X2, LayoutDashboard, Paperclip, Play, Plus, Search, Send, Settings, Sparkles, UsersRound, X } from 'lucide-react';
import './styles.css';

const navItems = [
  { label: '工作台', icon: LayoutDashboard },
  { label: '知识库', icon: BookOpen },
  { label: '任务中心', icon: ClipboardList },
  { label: '应用集成', icon: Grid2X2 },
  { label: '团队协作', icon: UsersRound },
  { label: '系统设置', icon: Settings },
];

const steps = [
  ['理解任务需求', '识别意图：分析本月销售数据'],
  ['检索相关数据', '从知识库中查询销售数据、市场报告等 3 个来源'],
  ['数据分析与计算', '使用分析工具进行趋势分析、同比环比计算'],
  ['生成分析结果', '整理关键发现并生成可视化图表'],
];

function App() {
  const [activeNav, setActiveNav] = useState('工作台');
  const [running, setRunning] = useState(false);
  const [approved, setApproved] = useState(false);
  const [approvalTaskId, setApprovalTaskId] = useState('demo-2');
  const [taskText, setTaskText] = useState('');
  const [toast, setToast] = useState('');
  const [lastRun, setLastRun] = useState(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [docTitle, setDocTitle] = useState('');
  const [docContent, setDocContent] = useState('');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeResults, setKnowledgeResults] = useState([]);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [taskFilter, setTaskFilter] = useState('全部');
  const [centerTasks, setCenterTasks] = useState([
    { title: 'Q2 销售策略分析', status: '进行中', date: '2025-05-20', owner: 'AI Agent' },
    { title: '重点客户跟进计划', status: '待审批', date: '2025-05-22', owner: '华东销售团队' },
    { title: '华东区域市场调研', status: '已完成', date: '2025-05-18', owner: '李天恩' },
    { title: '核心产品 A 系列复盘', status: '待开始', date: '2025-05-26', owner: 'AI Agent' },
  ]);
  const loadTasks = async () => { try { const response = await fetch('/api/tasks'); const result = await response.json(); setCenterTasks((result.tasks || []).map(task => ({ ...task, status: ({ running: '进行中', approval: '待审批', completed: '已完成', pending: '待开始' }[task.status] || task.status), date: task.date || task.updated_at?.slice(0, 10), owner: task.owner || 'AI Agent' }))); } catch { notify('任务列表加载失败，当前显示本地数据'); } };

  const notify = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const runAgent = () => {
    setRunning(true);
    notify('Agent 已开始执行任务');
    window.setTimeout(() => setRunning(false), 2800);
  };

  const sendTask = async () => {
    if (!taskText.trim()) return;
    const task = taskText.trim();
    setTaskText('');
    setRunning(true);
    notify('Agent 正在执行任务...');
    try {
      const response = await fetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Agent 执行失败');
      setLastRun({ task, summary: result.summary, mode: result.mode });
      await loadTasks();
      notify(result.summary || `已创建任务：${task}`);
    } catch (error) {
      setLastRun({ task, summary: error.message, mode: 'error' });
      notify(error.message || `任务执行失败：${task}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><span></span><span></span></div><div><strong>FlowPilot</strong><small>AI 驱动的企业工作流平台</small></div></div>
        <nav className="main-nav">
          {navItems.map(({ label, icon: Icon }) => <button key={label} className={activeNav === label ? 'nav-item active' : 'nav-item'} onClick={() => { setActiveNav(label); if (label === '知识库') setKnowledgeOpen(true); else if (label === '任务中心') { setTaskCenterOpen(true); loadTasks(); } else notify(`${label}模块即将上线`); }}><Icon size={20} strokeWidth={1.9} /><span>{label}</span></button>)}
        </nav>
        <div className="team-switcher"><div className="team-icon"><BriefcaseBusiness size={18} /></div><div><span>企业版</span><strong>华东销售团队</strong></div><ChevronDown size={16} /></div>
      </aside>

      <main className="workspace">
        <header className="topbar"><div className="top-search"><Search size={18} /><span>搜索知识库、任务或提问...</span><kbd>⌘ K</kbd></div><button className="icon-button" aria-label="通知"><Bell size={20} /></button><div className="avatar">F</div></header>
        <div className="content-grid">
          <section className="main-column">
            <div className="intro"><h1>你好！我可以帮你处理业务问题</h1><p>基于企业知识库与多智能体协作，完成从分析到执行的全流程任务。</p></div>
            <div className="conversation">
              <div className="user-message"><div className="message-avatar user"><CircleUserRound size={19} /></div><div className="message-bubble">分析本月销售数据</div><time>今天 10:24</time></div>
              <div className="ai-message"><div className="message-avatar ai"><Sparkles size={19} /></div><div className="ai-body"><h3>我已完成本月销售数据的分析，结果如下：</h3><ul><li>本月总销售额为 <b>¥4,320 万</b>，较上月增长 12.5%，较去年同期增长 28.1%。</li><li>企业客户（To B）仍为主要增长来源，占比 68%。</li><li>华东区域表现最为突出，销售额较上月增长 18.7%。</li><li>核心产品 A 系列增长显著，建议调整企业销售端排期。</li></ul>
                <div className="chart-panel"><div className="chart-head"><strong>本月销售趋势</strong><span><i></i>销售额（万元）</span></div><div className="chart-area"><div className="y-axis"><span>6,000</span><span>4,500</span><span>3,000</span><span>1,500</span><span>0</span></div><div className="chart"><div className="grid-lines"></div><svg viewBox="0 0 560 180" preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#3169ee" stopOpacity=".22"/><stop offset="1" stopColor="#3169ee" stopOpacity="0"/></linearGradient></defs><path d="M0,143 C35,137 42,139 75,119 S120,127 150,105 S195,118 225,91 S270,101 305,84 S350,96 380,69 S425,80 455,58 S505,72 560,38 L560,180 L0,180 Z" fill="url(#fill)"/><path d="M0,143 C35,137 42,139 75,119 S120,127 150,105 S195,118 225,91 S270,101 305,84 S350,96 380,69 S425,80 455,58 S505,72 560,38" fill="none" stroke="#3169ee" strokeWidth="3" strokeLinecap="round"/></svg><div className="x-axis"><span>5月1日</span><span>5月7日</span><span>5月14日</span><span>5月21日</span><span>5月28日</span></div></div><div className="chart-total"><strong>¥ 4,320 万</strong><em>↑ 12.5%</em><span>较上月</span></div></div></div>
                <div className="sources"><h3>来源引用</h3>{[['销售数据_2025年5月.xlsx','企业知识库','销售数据','2025-05-31','blue'],['市场分析报告_2025Q2.pdf','企业知识库','市场研究','2025-04-28','pink'],['客户行业分布数据表.xlsx','企业知识库','客户管理','2025-05-20','green']].map(([name, tag, type, date, color]) => <div className="source-row" key={name}><div className={`file-icon ${color}`}><FileText size={16} /></div><strong>{name}</strong><span>{tag}</span><span>{type}</span><time>{date}</time><ArrowUpRight size={16} /></div>)}</div><time className="ai-time">今天 10:25</time></div></div>
              <div className="composer"><Paperclip size={20} /><input value={taskText} onChange={e => setTaskText(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendTask()} placeholder="继续提问，或输入新的任务需求..." /><button onClick={sendTask}><Send size={18} /></button></div>
              {lastRun && <div className={`run-result ${lastRun.mode === 'error' ? 'error' : ''}`}><strong>{lastRun.mode === 'fallback' ? '已使用降级模式完成' : lastRun.mode === 'error' ? '任务执行失败' : 'Agent 已完成任务'}</strong><span>{lastRun.summary}</span></div>}
            </div>
          </section>

          <aside className="right-column">
            <section className="trace-panel"><div className="panel-title"><div><Activity size={20} color="#285eea" /><h2>Agent 执行轨迹</h2></div><button onClick={() => notify('轨迹面板已收起')}>收起 <ChevronDown size={15} /></button></div><div className="timeline">{steps.map(([title, desc], i) => <div className={`timeline-step ${i < 4 ? 'done' : ''}`} key={title}><div className="step-dot">{i < 4 ? <Check size={13} /> : ''}</div><div><strong>{title}</strong><time>10:{24 + Math.floor(i / 2)}</time><p>{desc}</p></div></div>)}<div className={`timeline-step ${running ? 'current' : ''}`}><div className="step-dot"></div><div><strong>待人工审批</strong><p>请审核分析结果并选择后续操作</p></div></div></div></section>
            <section className="approval-panel"><div className="approval-title"><div className="approval-icon"><UsersRound size={19} /></div><div><h2>待人工审批</h2><p>分析结果已生成，请确认后执行后续操作。</p></div></div><div className="approval-file"><div className="report-icon"><FileBarChart size={20} /></div><div><strong>本月销售分析报告</strong><span>包含数据分析、图表和关键结论</span></div><button onClick={() => notify('报告预览已打开')}>预览</button></div><div className="approval-actions"><button className="primary" onClick={async () => { const response = await fetch(`/api/tasks/${approvalTaskId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'generate_report' }) }); if (response.ok) { setApproved(true); notify('分析汇报已生成并完成审批'); } }} disabled={approved}><FileBarChart size={17} />{approved ? '已生成汇报' : '生成汇报'}</button><button onClick={async () => { const response = await fetch(`/api/tasks/${approvalTaskId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create_follow_up_task' }) }); if (response.ok) { setApproved(true); notify('跟进任务已创建并完成审批'); } }}><Plus size={17} />创建跟进任务</button></div></section>
            <section className="tasks-panel"><div className="panel-title"><div><ClipboardList size={19} /><h2>相关任务</h2></div><button onClick={() => setActiveNav('任务中心')}>查看全部 <ArrowUpRight size={15} /></button></div>{[['Q2 销售策略分析','进行中','2025-05-20','blue'],['重点客户跟进计划','待开始','2025-05-22','gray'],['华东区域市场调研','已完成','2025-05-18','green']].map(([name,status,date,color]) => <div className="task-row" key={name}><span className="check-circle"></span><strong>{name}</strong><em className={color}>{status}</em><time>{date}</time></div>)}</section>
          </aside>
        </div>
      </main>
      {toast && <div className="toast"><Check size={16} />{toast}<button onClick={() => setToast('')}><X size={14} /></button></div>}
      {knowledgeOpen && <div className="drawer-backdrop" onClick={() => setKnowledgeOpen(false)}><section className="knowledge-drawer" onClick={event => event.stopPropagation()}><div className="drawer-header"><div><BookOpen size={20} color="#285bea" /><div><h2>知识库</h2><p>上传企业资料，为 Agent 提供可靠上下文。</p></div></div><button onClick={() => setKnowledgeOpen(false)}><X size={19} /></button></div><div className="knowledge-form"><label>文档标题<input value={docTitle} onChange={event => setDocTitle(event.target.value)} placeholder="例如：销售分析说明" /></label><label>文档内容<textarea value={docContent} onChange={event => setDocContent(event.target.value)} placeholder="粘贴一段企业知识、业务规则或数据说明..." /></label><button className="ingest-button" onClick={async () => { if (!docTitle.trim() || !docContent.trim()) return notify('请先填写文档标题和内容'); const response = await fetch('/api/knowledge/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: docTitle, content: docContent }) }); const result = await response.json(); notify(`文档已入库，生成 ${result.chunks || 0} 个知识片段`); setDocTitle(''); setDocContent(''); }}><Plus size={17} />入库文档</button></div><div className="knowledge-search"><div className="search-title"><strong>检索知识库</strong><span>{knowledgeResults.length} 条结果</span></div><div className="knowledge-search-box"><Search size={17} /><input value={knowledgeQuery} onChange={event => setKnowledgeQuery(event.target.value)} onKeyDown={async event => { if (event.key !== 'Enter' || !knowledgeQuery.trim()) return; const response = await fetch(`/api/knowledge/search?q=${encodeURIComponent(knowledgeQuery)}`); const result = await response.json(); setKnowledgeResults(result.results || []); }} placeholder="输入关键词后按 Enter..." /></div><div className="knowledge-results">{knowledgeResults.map(item => <article key={item.id}><strong>{item.title || item.metadata?.title || '知识片段'}</strong><p>{item.content}</p></article>)}</div></div></section></div>}
      {taskCenterOpen && <div className="drawer-backdrop" onClick={() => setTaskCenterOpen(false)}><section className="knowledge-drawer task-drawer" onClick={event => event.stopPropagation()}><div className="drawer-header"><div><ClipboardList size={20} color="#285bea" /><div><h2>任务中心</h2><p>查看 Agent 和团队协作产生的全部任务。</p></div></div><button onClick={() => setTaskCenterOpen(false)}><X size={19} /></button></div><div className="task-filters">{['全部', '进行中', '待审批', '已完成'].map(filter => <button key={filter} className={taskFilter === filter ? 'selected' : ''} onClick={() => setTaskFilter(filter)}>{filter}</button>)}</div><div className="center-task-list">{centerTasks.filter(task => taskFilter === '全部' || task.status === taskFilter).map(task => <article className="center-task" key={task.title}><div className="center-task-main"><span className={`status-dot ${task.status === '已完成' ? 'success' : task.status === '待审批' ? 'warning' : 'primary'}`}></span><div><strong>{task.title}</strong><span>{task.owner} · {task.date}</span></div></div><em className={task.status === '已完成' ? 'green' : task.status === '待审批' ? 'orange' : 'blue'}>{task.status}</em></article>)}</div></section></div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
