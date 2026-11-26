from xml.sax.saxutils import escape
from pathlib import Path
O=Path(__file__).parent
ACCENT='#5579d5';INK='#252b30';MUTED='#89929a';LINE='#e7eaed';BG='#f5f6f7'

def rect(x,y,w,h,fill='#fff',rx=0,stroke='none'):
 return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}"/>'
def text(x,y,s,size=14,color=INK,weight=400,anchor='start'):
 return f'<text x="{x}" y="{y}" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="{size}" fill="{color}" font-weight="{weight}" text-anchor="{anchor}">{escape(s)}</text>'
def line(x1,y1,x2,y2,color=LINE,w=1): return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{w}"/>'
def circle(cx,cy,r,fill='none',stroke=LINE,sw=1):return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'
def header(w=1600):
 return rect(0,0,w,64,'#fff')+line(0,64,w,64)+rect(21,18,28,28,ACCENT,9)+text(35,38,'知',15,'#fff',700,'middle')+text(60,38,'知行',17,INK,700)+rect(260,14,420,36,'#fafbfb',9,LINE)+text(277,37,'⌕  搜索任务、笔记、资料…',13,'#9aa1a8')+text(653,37,'⌘ K',10,'#a0a7ad')+text(w-158,38,'◷ 已同步',12,'#7f898f')+circle(w-75,32,15,'#e9effb','none')+text(w-75,36,'林',12,'#657eae',700,'middle')
def sidebar(active='今天',width=230,height=900):
 out=rect(0,64,width,height-64,'#fff')+line(width,64,width,height)
 out+=rect(12,82,width-24,38,ACCENT,8)+text(26,106,'＋  快速创建',13,'#fff',600)
 labels=[('工作台',''),('◷　今天','5'),('⌑　收件箱','8'),('▦　日历',''),('我的空间',''),('●　工作',''),('●　生活',''),('●　阅读计划',''),('知识',''),('▤　全部笔记','24'),('⌁　剪藏箱','3'),('★　收藏',''),('快速筛选',''),('⚑　高优先级',''),('▱　关联任务','')]
 y=157
 for label,count in labels:
  if not label.startswith(('工作台','我的空间','知识','快速筛选')):
   isactive=active in label
   if isactive:out+=rect(8,y-18,width-16,34,'#edf2fc',8)
   c='#4665af' if isactive else '#5f6971';out+=text(23,y+4,label,12,c,600 if isactive else 400)
   if count:out+=text(width-19,y+4,count,10,'#98a1a7',400,'end')
  else:out+=text(19,y,label,10,'#a1a8ad',500)
  y+=36 if label.startswith(('工作台','我的空间','知识','快速筛选')) else 33
 return out

def task_row(y,title,meta,done=False,priority='',note=None):
 out=circle(270,y-4,8,'#38ad73' if done else '#fff','#38ad73' if done else '#c6cdd1',1.5)
 if done:out+=text(270,y, '✓',9,'#fff',700,'middle')
 out+=text(291,y,title,14,'#a8afb4' if done else INK,500)
 out+=text(291,y+19,meta,11,'#939da4')
 if note:out+=rect(688,y-19,142,22,'#f1edfb',11)+text(759,y-4,'▤  '+note,10,'#765abd',500,'middle')
 if priority:out+=text(930,y-3,priority,10,'#df9a5d',600,'end')
 out+=line(256,y+31,950,y+31,'#f0f2f3')
 return out

def today_svg():
 w,h=1600,1000; out=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'+rect(0,0,w,h,BG)+rect(0,0,w,64,'#fff')+header(w)+sidebar('◷　今天',230,h)
 out+=rect(230,64,1020,h-64,'#fff')+line(1250,64,1250,h)
 out+=text(260,112,'今天',25,INK,700)+text(260,137,'把重要的事，一件一件做好',12,MUTED)+text(1215,114,'周六，10月24日  ⌄',12,'#7d878e',400,'end')
 out+=rect(260,160,230,34,'#f3f5f6',8)+text(300,182,'列表',11,MUTED,400,'middle')+text(378,182,'四象限',11,INK,600,'middle')+text(460,182,'看板',11,MUTED,400,'middle')+rect(510,160,130,34,'#fff',8,LINE)+text(575,182,'▦  安排到日历',11,'#69747b',400,'middle')+text(1225,182,'···',18,MUTED,400,'end')
 out+=text(260,223,'范围',11,'#7c8791',600)+rect(302,202,60,28,'#edf2fc',7)+text(332,220,'今天',10,'#4e6eb9',600,'middle')+rect(369,202,60,28,'#f4f6f6',7)+text(399,220,'全部',10,'#74808d',400,'middle')+text(450,220,'拖动任务到其他象限，或点象限标记调整；未设置时默认第四象限。',10,'#929ba5')
 quadrants=[(260,244,455,205,'重要且紧急','现在处理 · 1','完成新版产品需求文档','今天 10:30 · 高优先级','#d97664'),(735,244,455,205,'重要不紧急','安排时间 · 1','整理竞品体验记录','今天 · 已关联笔记','#5579d5'),(260,465,455,205,'紧急不重要','尽量委托 · 1','预约下周牙医','今天 15:00 提醒','#d89338'),(735,465,455,205,'不重要不紧急','未分类，默认 · 2','阅读《设计中的设计》第二章','今天 · 阅读计划','#8066c7')]
 for x,y,wq,hq,title,count,task,meta,tone in quadrants:
  out+=rect(x,y,wq,hq,'#fff',12,'#e7eaed')+rect(x,y,wq,4,tone)+text(x+18,y+30,title,13,INK,650)+text(x+wq-16,y+30,count,10,'#8c96a1',400,'end')+circle(x+23,y+64,7,'#fff','#c6cdd1',1.4)+text(x+40,y+68,task,12,INK,550)+text(x+40,y+88,meta,10,'#929ba5')+rect(x+17,y+hq-40,103,25,'#fff',7,'#e7eaed')+text(x+68,y+hq-23,'＋ 新建任务',10,'#68747f',500,'middle')
 out+=text(260,710,'象限可在任务详情中选择；priority 优先级独立保存，不自动决定象限。',10,'#929ba5')
 # detail pane
 out+=rect(1250,64,350,h-64,'#fcfcfc')+text(1274,99,'工作  ›  任务详情',11,'#98a1a6')+text(1570,99,'···',16,'#8d979d',400,'end')
 out+=text(1274,145,'完成新版产品需求文档',17,INK,650)+rect(1274,163,50,22,'#eef2fb',11)+text(1299,178,'今天',10,'#6880b8',500,'middle')+rect(1332,163,82,22,'#fff4e8',11)+text(1373,178,'高优先级',10,'#b68148',500,'middle')
 for yy,left,right in [(223,'◷ 截止时间','今天 10:30'),(262,'♧ 提醒','提前 30 分钟'),(301,'▤ 清单','工作'),(340,'⚑ 标签','产品设计')]:
  out+=text(1274,yy,left,11,'#68727a')+text(1570,yy,right,11,'#394249',500,'end')+line(1274,yy+14,1576,yy+14)
 out+=text(1274,399,'任务备注',12,INK,650)+text(1274,422,'收敛任务与知识的融合边界，明确首期范围。',11,'#7b858c')
 out+=text(1274,468,'关联笔记  2',12,INK,650)
 for yy,title,desc in [(483,'产品方向与用户场景','任务是下一步行动，笔记保存上下文…'),(555,'为知笔记 X 体验拆解','轻文档、混排组件、目录树与搜索…')]:
  out+=rect(1274,yy,302,60,'#fff',9,'#e7ece9')+rect(1285,yy+12,25,25,'#eff7f2',7)+text(1297,yy+29,'▤',12,ACCENT,600,'middle')+text(1318,yy+24,title,11,INK,600)+text(1318,yy+43,desc,10,'#818a91')
 out+=rect(1274,631,302,32,'#fff',8,LINE)+text(1425,652,'＋ 关联笔记',11,'#667178',500,'middle')+rect(1274,678,302,53,'#f3f7f4',9)+text(1288,699,'完成任务后，可把结果写进关联笔记。',10,'#77837b')+text(1288,716,'两个对象保持独立保存。',10,'#77837b')
 return out+'</svg>'

def notes_svg():
 w,h=1600,1000;out=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'+rect(0,0,w,h,BG)+header(w)+sidebar('▤　全部笔记',230,h)
 out+=rect(230,64,1370,h-64,'#fff')
 out+=text(260,112,'知识',25,INK,700)+text(260,137,'笔记、资料与行动在同一条工作线上  ·  5 篇笔记',12,MUTED)+rect(1330,92,110,34,'#fff',8,LINE)+text(1385,114,'⇧  导入',11,'#69747b',400,'middle')+rect(1450,92,120,34,ACCENT,8)+text(1510,114,'＋ 新笔记',11,'#fff',600,'middle')
 # three panels (tree, docs list, doc canvas)
 out+=rect(230,158,1370,778,'#fbfcfc',12,'#e7eaed')
 out+=rect(236,164,258,766,'#fff',9)+line(494,164,494,930)+rect(494,164,300,766,'#fbfcfc')+line(794,164,794,930)
 out+=text(252,200,'个人笔记',14,INK,650)+text(474,200,'＋',15,MUTED)
 y=240
 for s,c in [('⌄　我的笔记',INK),('　　所有笔记','#69737a'),('　　产品设计',ACCENT),('　　　任务管理','#6d787f'),('　　　用户研究','#6d787f'),('　　工作记录','#6d787f'),('⌄　个人成长',INK),('　　读书笔记','#6d787f'),('⌄　剪藏箱　3',INK)]:
  if s.strip().startswith('产品设计'):out+=rect(242,y-18,246,31,'#edf2fc',7)
  out+=text(256,y,s,12,c,500 if c==INK else 400);y+=35
 out+=text(252,615,'标签',10,'#a2a9ae',500)
 for i,s in enumerate(['# 产品','# 竞品体验','# 灵感']):out+=text(257,648+i*31,s,11,'#737d84')
 out+=text(516,201,'产品设计',14,INK,650)+text(770,201,'＋',15,MUTED,400,'end')
 out+=text(516,222,'5 篇笔记',10,'#98a2ab')+text(770,222,'⇅ 排序',10,'#98a2ab',400,'end')
 docs=[('为知笔记 X 体验拆解','刚刚编辑',2,True),('任务管理产品方向','昨天',4,False),('用户访谈摘录','10月21日',1,False),('周计划与复盘','10月20日',0,False),('读书摘录','10月18日',1,False)]
 y=270
 for title,meta,links,sel in docs:
  if sel:out+=rect(502,y-24,284,72,'#fff',9,'#d9e4f6')
  out+=text(518,y,title,12,'#2f4a72' if sel else INK,600 if sel else 500)+text(518,y+21,meta,10,'#929ba1')
  if links:out+=rect(518,y+28,74,18,'#eaf6ee',5)+text(555,y+41,f'▤ 关联 {links}',9,'#4665af',500,'middle')
  out+=text(752,y,'☆',11,'#c3cbd2',400,'end')
  if not sel:out+=line(516,y+34,776,y+34,'#f0f2f3')
  y+=76
 # doc content canvas
 out+=rect(794,164,806,766,'#fff')+text(830,199,'产品设计  ›  任务管理',11,'#8f999f')+text(1568,199,'● 已保存　···',11,'#8f999f',400,'end')
 out+=text(830,259,'为知笔记 X 体验拆解',27,INK,700)+text(830,289,'林　·　刚刚编辑　·　Markdown　·　可离线编辑',11,'#9ba3a9')+line(830,311,1560,311)
 out+=text(830,351,'把行动和知识放在同一条工作流里，',14,'#4d575e')+text(830,375,'但保留两类对象各自舒服的使用方式。',14,'#4d575e')
 out+=text(830,427,'体验观察',17,INK,650)
 for i,s in enumerate(['任务列表要轻：完成、排序、时间和优先级一眼可见。','笔记是轻文档：正文支持混排，目录与同级笔记持续可达。','从资料到行动：从段落创建任务，任务保留来源笔记和引用片段。']):
  out+=circle(838,459+i*29,2,'#657078','none')+text(852,463+i*29,s,12,'#59636a')
 out+=rect(830,566,728,66,'#f4faf6',7)+rect(830,566,3,66,'#80c99b')+text(848,590,'设计原则：不把长文塞进任务备注；在任务详情中预览关联笔记，',11,'#52635a')+text(848,610,'需要深读时打开完整文档。',11,'#52635a')
 out+=text(830,682,'下一步行动',17,INK,650)+rect(830,700,340,38,'#fff',8,'#e5ece7')+circle(850,719,8,'#fff','#bbc6c0',1.4)+text(870,724,'完成产品信息架构评审 · 今天 11:00',11,'#45845f',500)
 out+=text(830,787,'关联内容',17,INK,650)+text(830,820,'← 已关联到任务：完成新版产品需求文档',12,'#6a6f86')+text(830,856,'[[用户访谈摘录]]　 [[产品方向与用户场景]]',12,'#498962')
 out+=rect(830,884,180,34,'#fff',8,LINE)+text(920,906,'＋ 从文字创建任务',11,'#647078',500,'middle')
 # outline strip far right nested in document page
 out+=line(1500,332,1500,860,'#eef0f1')+text(1520,357,'本文目录',11,INK,650)+text(1520,386,'体验观察',10,'#6c767d')+text(1520,409,'下一步行动',10,'#6c767d')+text(1520,432,'关联内容',10,'#6c767d')
 return out+'</svg>'

def mobile_svg():
 w,h=430,900;out=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'+rect(0,0,w,h,'#f3f4f5')+rect(12,12,406,876,'#fff',34,'#dfe2e4')
 out+=rect(12,12,406,59,'#fff',30)+rect(12,42,406,29,'#fff')+rect(28,29,25,25,ACCENT,8)+text(40,47,'知',13,'#fff',700,'middle')+text(62,47,'今天',17,INK,650)+text(387,47,'⌕',20,'#707a80',400,'middle')+line(12,71,418,71)
 out+=text(31,112,'周六，10月24日',11,MUTED)+text(31,145,'今天',25,INK,700)+text(393,139,'⋯',20,MUTED,400,'end')
 out+=rect(28,162,374,38,'#f4f6f7',9)+rect(31,165,70,32,'#fff',7)+text(66,186,'列表',11,INK,600,'middle')+text(145,186,'四象限',11,MUTED,400,'middle')+text(229,186,'看板',11,MUTED,400,'middle')+text(382,186,'筛选',11,MUTED,400,'end')
 out+=text(31,235,'上午 · 3 项',11,'#9ba3a9',500)
 items=[('完成新版产品需求文档','工作 · 10:30 · 高优先级','方案草稿'),('和设计师确认首页信息架构','工作 · 11:00','访谈摘录'),('整理竞品体验记录','工作 · 已关联笔记','竞品分析'),('预约下周牙医','生活 · 15:00 提醒','')]
 y=270
 for idx,(title,meta,note) in enumerate(items):
  out+=circle(41,y-4,8,'#fff','#c4ccd0',1.5)+text(61,y,title,12,INK,550)+text(61,y+20,meta,10,'#929ba1')
  if note:out+=rect(61,y+27,92,18,'#f1edfb',9)+text(107,y+40,'▤ '+note,9,'#44895f',500,'middle')
  out+=line(29,y+50,401,y+50,'#f0f1f2');y+=82
 out+=text(31,635,'下午 · 2 项',11,'#9ba3a9',500)+circle(41,662,8,'#fff','#c4ccd0',1.5)+text(61,666,'阅读《设计中的设计》第二章',12,INK,550)+text(61,686,'阅读计划 · 专注 25 分钟',10,'#929ba1')+rect(61,694,85,18,'#f1edfb',9)+text(103,707,'▤ 读书摘录',9,'#44895f',500,'middle')
 out+=line(12,803,418,803,'#e8ebed')
 for x,sym,label,sel in [(63,'◷','今天',True),(151,'▦','日历',False),(279,'▤','知识',False),(367,'☰','我的',False)]:
  col=ACCENT if sel else '#9ba3a9';out+=text(x,837,sym,19,col,500,'middle')+text(x,858,label,9,col,500,'middle')
 out+=circle(215,826,22,ACCENT,'#fff',3)+text(215,834,'＋',25,'#fff',400,'middle')
 return out+'</svg>'

def board_svg():
 w,h=1600,1000;out=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'+rect(0,0,w,h,BG)+rect(0,0,w,64,'#fff')+header(w)+sidebar('◷　今天',230,h)
 out+=rect(230,64,1370,h-64,'#fff')
 # page head: breadcrumb, title, status, actions
 out+=text(260,100,'知识　/　产品设计　/　Q4 规划　/　画板',10,MUTED)
 out+=text(260,138,'Q4 目标拆解',25,INK,700)+text(260,160,'● 已保存到本机',10,'#2f9e73',500)
 out+=rect(1318,112,80,34,'#fff',8,LINE)+text(1358,134,'▣ 阅读',11,'#69747b',400,'middle')
 out+=rect(1406,112,80,34,'#fff',8,LINE)+text(1446,134,'↗ 分享',11,'#69747b',400,'middle')
 out+=rect(1494,112,76,34,'#5579d5',8)+text(1532,134,'保存',11,'#fff',600,'middle')
 # workspace
 out+=rect(230,182,1370,784,'#fbfefb',12,'#e7eaed')
 out+=rect(231,183,54,782,'#fff',11)
 for i,(icon,active) in enumerate([('↖',False),('◈',True),('T',False),('▱',False),('▧',False)]):
  y=214+i*44
  if active:out+=rect(238,y-22,40,38,'#eaf6ee',8)
  out+=text(258,y,icon,16,'#2f9e73' if active else '#68747f',500,'middle')
 out+=line(246,448,268,448,'#e7eaed')
 for i,icon in enumerate(['⌁','▣','〰','···']):
  out+=text(258,478+i*44,icon,16,'#68747f',400,'middle')
 # canvas dots
 for gx in range(300,1590,20):
  for gy in range(200,960,20):
   out+=f'<circle cx="{gx}" cy="{gy}" r=".9" fill="#e2e9e3"/>'
 # connectors
 out+=f'<path d="M 500 330 C 545 330, 545 330, 590 330" fill="none" stroke="#a5b2a9" stroke-width="2" marker-end="url(#boardArrow)"/>'
 out+=f'<path d="M 700 372 C 700 430, 620 450, 560 470" fill="none" stroke="#a5b2a9" stroke-width="2" marker-end="url(#boardArrow)"/>'
 out+=f'<defs><marker id="boardArrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#a5b2a9"/></marker></defs>'
 out+=text(534,320,'评审',10,'#76847a',400,'middle')+text(600,442,'是',10,'#76847a',400,'middle')
 # section container
 out+=rect(330,430,350,210,'#f6faf7',10,'#9bbca5')+text(348,458,'阶段一',11,'#4c6a55',600)
 # nodes
 out+=rect(352,300,148,58,'#eef8f1',9,'#86c69d')+text(426,334,'需求澄清',12,'#34424b',550,'middle')
 out+=rect(590,300,148,58,'#fff8e9',9,'#e5c477')+text(664,334,'对用户有价值？',12,'#34424b',550,'middle')
 out+=rect(470,470,148,58,'#fff7d9',9,'#e8d77a')+text(544,504,'先做最小可用版本',11,'#34424b',500,'middle')
 # selection on decision node
 out+=rect(586,296,156,66,'none',10,'#7aa889')
 for hx,hy in [(586,296),(742,296),(586,362),(742,362)]:out+=rect(hx-4,hy-4,8,8,'#fff',2,'#6f9a7b')
 for qx,qy in [(664,282),(664,380),(764,330),(564,330)]:out+=circle(qx,qy,8,'#fff','#8cb597')+text(qx,qy+4,'+',10,'#4f8b60',500,'middle')
 # zoom controls
 out+=rect(1240,880,330,40,'#fff',10,LINE)
 for i,s in enumerate(['↶','↷','−','100%　·　全览','＋']):
  out+=text(1272+i*68,905,s,11,'#68747f',500,'middle')
 out+=text(254,925,'● 已保存到本机',10,MUTED)
 return out+'</svg>'

for name,fn in [('01-today.svg',today_svg),('02-knowledge.svg',notes_svg),('03-mobile.svg',mobile_svg),('04-board.svg',board_svg)]:
 (O/name).write_text(fn(),encoding='utf-8')