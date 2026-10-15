import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { CopyOutlined, ReloadOutlined, SafetyOutlined, UserSwitchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  agentApi,
  staffApi,
  whitelabelApi,
} from '../services/api';
import type {
  SelectionMappingAuditLog,
  SelectionMappingMode,
  User,
  WhitelabelListItem,
  WhitelabelUser,
} from '../types';

const { Title, Text } = Typography;

const formatTime = (value?: string | null): string => {
  if (!value) return '-';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm:ss') : String(value);
};

const WhitelabelsPage: React.FC = () => {
  const [createForm] = Form.useForm();
  const [mappingForm] = Form.useForm();
  const [assignForm] = Form.useForm();
  const [whitelabels, setWhitelabels] = useState<WhitelabelListItem[]>([]);
  const [agents, setAgents] = useState<User[]>([]);
  const [staff, setStaff] = useState<User[]>([]);
  const [users, setUsers] = useState<WhitelabelUser[]>([]);
  const [auditLogs, setAuditLogs] = useState<SelectionMappingAuditLog[]>([]);
  const [selected, setSelected] = useState<WhitelabelListItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingMapping, setSavingMapping] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [userDrawerOpen, setUserDrawerOpen] = useState(false);

  const loadWhitelabels = useCallback(async (preferredId?: number) => {
    setLoading(true);
    try {
      const response = await whitelabelApi.getWhitelabels();
      if (!response.success || !response.data) {
        throw new Error(response.error || '读取白标列表失败');
      }
      const nextSelected = response.data.find(item => item.id === (preferredId ?? selected?.id)) || response.data[0] || null;
      setWhitelabels(response.data);
      setSelected(nextSelected);
      if (nextSelected) {
        mappingForm.setFieldsValue({
          mode: nextSelected.mapping_mode,
          enabled: nextSelected.mapping_enabled,
          reason: '',
        });
        const [userResponse, auditResponse] = await Promise.all([
          whitelabelApi.getWhitelabelUsers(nextSelected.id),
          whitelabelApi.getMappingAuditLogs(nextSelected.id),
        ]);
        setUsers(userResponse.data || []);
        setAuditLogs(auditResponse.data || []);
      } else {
        setUsers([]);
        setAuditLogs([]);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '读取白标数据失败');
    } finally {
      setLoading(false);
    }
  }, [mappingForm, selected?.id]);

  const loadAssignableUsers = useCallback(async () => {
    try {
      const [agentResponse, staffResponse] = await Promise.all([
        agentApi.getAgentList(),
        staffApi.getStaffList(),
      ]);
      setAgents(agentResponse.data || []);
      setStaff(staffResponse.data || []);
    } catch (error) {
      console.error('Failed to load assignable users:', error);
    }
  }, []);

  useEffect(() => {
    loadWhitelabels();
    loadAssignableUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ownerOptions = useMemo(() => [...agents, ...staff].map(user => ({
    label: `${user.username} (#${user.id}, ${user.role})`,
    value: user.id,
  })), [agents, staff]);

  const assignOptions = useMemo(() => {
    const byId = new Map<number, { label: string; value: number }>();
    for (const user of [...agents, ...staff]) {
      byId.set(user.id, { label: `${user.username} (#${user.id}, ${user.role})`, value: user.id });
    }
    return Array.from(byId.values());
  }, [agents, staff]);

  const handleCreate = async (values: { name: string; domain: string; owner_user_id?: number }) => {
    try {
      const response = await whitelabelApi.createWhitelabel(values);
      if (!response.success || !response.data) {
        throw new Error(response.error || '创建失败');
      }
      message.success(`白标 ${response.data.domain} 创建成功`);
      createForm.resetFields();
      await loadWhitelabels(response.data.id);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '创建白标失败');
    }
  };

  const handleSaveMapping = async (values: { mode: SelectionMappingMode; enabled: boolean; reason?: string }) => {
    if (!selected) return;
    setSavingMapping(true);
    try {
      const response = await whitelabelApi.updateMappingSettings(selected.id, values);
      if (!response.success || !response.data) {
        throw new Error(response.error || '切换失败');
      }
      message.success(response.message || `映射配置版本 v${response.data.version}`);
      await loadWhitelabels(selected.id);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '切换映射配置失败');
    } finally {
      setSavingMapping(false);
    }
  };

  const handleAssignUsers = async (values: { user_ids?: number[] }) => {
    if (!selected) return;
    const userIds = values.user_ids || [];
    if (userIds.length === 0) {
      message.warning('请选择要归属的用户');
      return;
    }
    setAssigning(true);
    try {
      const response = await whitelabelApi.assignUsers(selected.id, userIds);
      if (!response.success) {
        throw new Error(response.error || '归属更新失败');
      }
      message.success(response.message || '用户归属已更新');
      assignForm.resetFields();
      await loadWhitelabels(selected.id);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '更新用户归属失败');
    } finally {
      setAssigning(false);
    }
  };

  const handleToggleStatus = async (record: WhitelabelListItem) => {
    try {
      const response = await whitelabelApi.updateWhitelabel(record.id, {
        status: record.status === 'active' ? 'disabled' : 'active',
      });
      if (!response.success || !response.data) {
        throw new Error(response.error || '状态更新失败');
      }
      message.success(response.message || '白标状态已更新');
      await loadWhitelabels(record.id);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '更新白标状态失败');
    }
  };

  const handleCopyDomain = async (domain: string) => {
    try {
      await navigator.clipboard.writeText(domain);
      message.success('白标域名已复制');
    } catch {
      message.info(domain);
    }
  };

  const handleUseDomain = (domain: string) => {
    localStorage.setItem('whitelabelDomain', domain);
    message.success(`后续登录/API 请求将携带 ${domain}`);
  };

  const handleClearDomain = () => {
    localStorage.removeItem('whitelabelDomain');
    message.success('已恢复默认站点');
  };

  const columns: ColumnsType<WhitelabelListItem> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 60,
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 150,
      render: (value: string, record) => (
        <Space size={4}>
          <Text strong>{value}</Text>
          {record.is_default && <Tag color="blue">默认</Tag>}
        </Space>
      ),
    },
    {
      title: '域名',
      dataIndex: 'domain',
      width: 190,
      render: (value: string) => (
        <Space size={4}>
          <Text copyable={{ text: value }} style={{ fontFamily: 'monospace' }}>{value}</Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (status: string) => status === 'active'
        ? <Tag color="success">启用</Tag>
        : <Tag color="default">停用</Tag>,
    },
    {
      title: '用户',
      dataIndex: 'user_count',
      width: 70,
      align: 'center',
    },
    {
      title: '映射',
      key: 'mapping',
      width: 150,
      render: (_, record) => (
        <Space size={4} wrap>
          <Tag color={record.mapping_mode === 'inverse' ? 'orange' : 'green'}>
            {record.mapping_mode === 'inverse' ? '反向' : '原样'}
          </Tag>
          <Tag color={record.mapping_enabled ? 'red' : 'default'}>
            {record.mapping_enabled ? '开' : '关'}
          </Tag>
          <Text type="secondary">v{record.mapping_version}</Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      render: (_, record) => (
        <Space size={4}>
          <Button size="small" onClick={() => handleSelectRow(record)}>管理</Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopyDomain(record.domain)}>复制</Button>
          <Button size="small" onClick={() => handleUseDomain(record.domain)}>设为登录域名</Button>
          <Popconfirm
            title={record.status === 'active' ? '确认停用该白标？' : '确认启用该白标？'}
            onConfirm={() => handleToggleStatus(record)}
          >
            <Button size="small" danger={record.status === 'active'}>{record.status === 'active' ? '停用' : '启用'}</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const handleSelectRow = (record: WhitelabelListItem) => {
    setSelected(record);
    mappingForm.setFieldsValue({ mode: record.mapping_mode, enabled: record.mapping_enabled, reason: '' });
    whitelabelApi.getWhitelabelUsers(record.id).then(response => setUsers(response.data || [])).catch(() => setUsers([]));
    whitelabelApi.getMappingAuditLogs(record.id).then(response => setAuditLogs(response.data || [])).catch(() => setAuditLogs([]));
  };

  const userColumns: ColumnsType<WhitelabelUser> = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '用户名', dataIndex: 'username', width: 140 },
    { title: '角色', dataIndex: 'role', width: 90, render: (value: string) => <Tag>{value}</Tag> },
    { title: '邮箱', dataIndex: 'email', width: 190, render: (value: string | null) => value || '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 170, render: formatTime },
  ];

  const auditColumns: ColumnsType<SelectionMappingAuditLog> = [
    { title: '时间', dataIndex: 'created_at', width: 165, render: formatTime },
    {
      title: '变化',
      key: 'change',
      width: 230,
      render: (_, record) => (
        <Text style={{ fontSize: 12 }}>
          {record.from_mode}/{String(record.from_enabled)} → {record.to_mode}/{String(record.to_enabled)}
        </Text>
      ),
    },
    { title: '版本', key: 'version', width: 100, render: (_, record) => `v${record.from_version} → v${record.to_version}` },
    { title: '操作员', dataIndex: 'operator_username', width: 120, render: (value: string | null) => value || '-' },
    { title: '原因', dataIndex: 'reason', width: 220, render: (value: string | null) => value || '-' },
  ];

  return (
    <div style={{ padding: 12, background: '#f5f5f5', minHeight: '100%' }}>
      <Card
        title="白标 / 租户管理"
        extra={<Space>
          <Button icon={<ReloadOutlined />} onClick={() => loadWhitelabels()} loading={loading}>刷新</Button>
          <Button onClick={handleClearDomain}>恢复默认域名</Button>
        </Space>}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="本地靶场租户映射"
          description="白标用于区分登录归属。下注时系统会同时保存用户看到的选项和实际提交选项；identity 为原样，inverse 开启后 home/away、over/under 互换，draw 保持不变。"
        />
        <Table
          rowKey="id"
          columns={columns}
          dataSource={whitelabels}
          loading={loading}
          pagination={false}
          size="middle"
          onRow={(record) => ({ onClick: () => handleSelectRow(record) })}
          rowClassName={(record) => selected?.id === record.id ? 'ant-table-row-selected' : ''}
        />
      </Card>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={24} xl={8}>
          <Card title="创建白标站点" size="small">
            <Form form={createForm} layout="vertical" onFinish={handleCreate}>
              <Form.Item
                name="name"
                label="站点名称"
                rules={[{ required: true, message: '请输入站点名称' }, { min: 2, message: '至少2个字符' }]}
              >
                <Input placeholder="OEM Local Test" />
              </Form.Item>
              <Form.Item
                name="domain"
                label="站点域名"
                rules={[
                  { required: true, message: '请输入域名' },
                  { pattern: /^(?!-)[a-z0-9.-]+[a-z]$/i, message: '请输入有效域名，例如 oem-local.test' },
                ]}
              >
                <Input placeholder="oem-local.test" />
              </Form.Item>
              <Form.Item name="owner_user_id" label="归属用户（可选）">
                <Select allowClear placeholder="选择代理或员工" options={ownerOptions} showSearch optionFilterProp="label" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block>创建白标</Button>
            </Form>
          </Card>
        </Col>

        <Col xs={24} xl={16}>
          <Card
            title={`选择映射配置${selected ? `：${selected.name} / ${selected.domain}` : ''}`}
            size="small"
            extra={<Button icon={<UserSwitchOutlined />} disabled={!selected} onClick={() => setUserDrawerOpen(true)}>管理用户</Button>}
          >
            {selected ? (
              <Form form={mappingForm} layout="vertical" onFinish={handleSaveMapping}>
                <Row gutter={12}>
                  <Col xs={24} md={8}>
                    <Form.Item name="mode" label="映射模式" rules={[{ required: true }]}>
                      <Select
                        options={[
                          { label: 'identity：展示=执行', value: 'identity' },
                          { label: 'inverse：主客/大小互换', value: 'inverse' },
                        ]}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item name="enabled" label="映射开关" valuePropName="checked">
                      <Switch checkedChildren="开" unCheckedChildren="关" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item name="reason" label="变更原因（写入审计）">
                      <Input placeholder="本地靶场验证" />
                    </Form.Item>
                  </Col>
                </Row>
                <Space>
                  <Button type="primary" htmlType="submit" loading={savingMapping} icon={<SafetyOutlined />}>
                    保存并生成新版本
                  </Button>
                  <Text type="secondary">当前版本 v{selected.mapping_version}；无变化时不会递增版本</Text>
                </Space>
              </Form>
            ) : (
              <Text type="secondary">请先创建或选择白标站点</Text>
            )}
          </Card>
        </Col>
      </Row>

      <Card title={`审计记录${selected ? `：${selected.name}` : ''}`} style={{ marginTop: 12 }} size="small">
        <Table
          rowKey="id"
          columns={auditColumns}
          dataSource={auditLogs}
          pagination={{ pageSize: 5, size: 'small' }}
          size="small"
          locale={{ emptyText: '暂无审计记录' }}
        />
      </Card>

      <Drawer
        title={`白标用户：${selected?.name || ''}`}
        open={userDrawerOpen}
        onClose={() => setUserDrawerOpen(false)}
        width={760}
      >
        <Card size="small" title="批量归属用户" style={{ marginBottom: 12 }}>
          <Form form={assignForm} layout="vertical" onFinish={handleAssignUsers}>
            <Form.Item name="user_ids" label="选择代理 / 员工" rules={[{ required: true, message: '请选择用户' }]}>
              <Select mode="multiple" allowClear placeholder="选择用户" options={assignOptions} showSearch optionFilterProp="label" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={assigning}>更新归属</Button>
          </Form>
        </Card>
        <Table
          rowKey="id"
          columns={userColumns}
          dataSource={users}
          pagination={false}
          size="small"
        />
      </Drawer>
    </div>
  );
};

export default WhitelabelsPage;
