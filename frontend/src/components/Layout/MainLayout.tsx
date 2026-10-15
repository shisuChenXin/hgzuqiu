import React, { useState, useEffect } from 'react';
import { Layout, Menu, Avatar, Dropdown, Space, Button, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  UserOutlined,
  TeamOutlined,
  DollarOutlined,
  DashboardOutlined,
  SettingOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  CalendarOutlined,
  FileTextOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { coinApi } from '../../services/api';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

type MenuItem = Required<MenuProps>['items'][number];

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = useState(window.innerWidth <= 768);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [coinBalance, setCoinBalance] = useState(0);
  const { user, logout, isAdmin, isAgent } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      if (mobile) {
        setCollapsed(true);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 监听路由变化，手机端自动收起侧边栏
  useEffect(() => {
    if (isMobile) {
      setCollapsed(true);
    }
  }, [location.pathname, isMobile]);

  useEffect(() => {
    loadCoinBalance();
    const interval = setInterval(loadCoinBalance, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadCoinBalance = async () => {
    try {
      const response = await coinApi.getBalance();
      if (response.success && response.data) {
        setCoinBalance(response.data.balance);
      }
    } catch (error) {
      console.error('Failed to load coin balance:', error);
    }
  };

  const getMenuItems = (): MenuItem[] => {
    const baseItems: MenuItem[] = [
      {
        key: '/dashboard',
        icon: <DashboardOutlined />,
        label: '数据看板',
      },
    ];

    if (isAdmin) {
      baseItems.push(
        {
          key: '/agents',
          icon: <TeamOutlined />,
          label: '代理管理',
        },
        {
          key: '/staff',
          icon: <TeamOutlined />,
          label: '员工管理',
        },
        {
          key: '/accounts',
          icon: <UserOutlined />,
          label: '账号管理',
        },
        {
          key: '/betting',
          icon: <FileTextOutlined />,
          label: '下注记录',
        },
        {
          key: '/live-wagers',
          icon: <DollarOutlined />,
          label: '实时注单',
        },
        {
          key: '/matches',
          icon: <CalendarOutlined />,
          label: '赛事管理',
        },
        {
          key: '/whitelabels',
          icon: <GlobalOutlined />,
          label: '白标管理',
        },
        {
          key: '/coins',
          icon: <DollarOutlined />,
          label: '金币流水',
        }
      );
    }

    if (isAgent && !isAdmin) {
      baseItems.push(
        {
          key: '/staff',
          icon: <TeamOutlined />,
          label: '员工管理',
        },
        {
          key: '/accounts',
          icon: <UserOutlined />,
          label: '账号管理',
        },
        {
          key: '/betting',
          icon: <FileTextOutlined />,
          label: '下注记录',
        },
        {
          key: '/live-wagers',
          icon: <DollarOutlined />,
          label: '实时注单',
        },
        {
          key: '/coins',
          icon: <DollarOutlined />,
          label: '金币流水',
        }
      );
    }

    if (user?.role === 'staff') {
      baseItems.push(
        {
          key: '/accounts',
          icon: <UserOutlined />,
          label: '账号管理',
        },
        {
          key: '/betting',
          icon: <FileTextOutlined />,
          label: '下注记录',
        },
        {
          key: '/live-wagers',
          icon: <DollarOutlined />,
          label: '实时注单',
        },
        {
          key: '/matches',
          icon: <CalendarOutlined />,
          label: '赛事管理',
        },
        {
          key: '/coins',
          icon: <DollarOutlined />,
          label: '金币流水',
        }
      );
    }

    baseItems.push({
      key: '/settings',
      icon: <SettingOutlined />,
      label: '个人中心',
    });

    return baseItems;
  };

  const menuItems = getMenuItems();

  const userMenuItems = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人信息',
      onClick: () => navigate('/settings'),
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: logout,
    },
  ];

  const handleMenuClick = ({ key }: { key: string }) => {
    navigate(key);
    // 手机端点击菜单后自动收起侧边栏
    if (isMobile) {
      setCollapsed(true);
    }
  };

  return (
    <Layout style={{ minHeight: '100vh', height: '100vh', background: 'transparent', overflow: 'hidden' }}>
      {!collapsed && isMobile && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.2)',
            backdropFilter: 'blur(2px)',
            zIndex: 1000,
          }}
          onClick={() => setCollapsed(true)}
        />
      )}
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={240}
        collapsedWidth={isMobile ? 0 : 80}
        style={{
          background: '#FFFFFF',
          borderRight: '1px solid #E5E7EB',
          position: isMobile ? 'fixed' : 'relative',
          height: '100vh',
          zIndex: 1001,
          boxShadow: '4px 0 24px 0 rgba(0,0,0,0.02)',
          left: isMobile && collapsed ? '-240px' : '0',
          transition: 'all 0.2s',
        }}
      >
        <div style={{
          height: 80,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid #F3F4F6',
        }}>
          {collapsed ? (
            <img
              src="/favicon.svg"
              alt="Logo"
              style={{
                width: 40,
                height: 40,
              }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <img
                src="/favicon.svg"
                alt="Logo"
                style={{
                  width: 36,
                  height: 36,
                }}
              />
              <span style={{
                fontSize: 18,
                fontWeight: 700,
                color: '#111827',
                letterSpacing: '0.5px'
              }}>智投系统</span>
            </div>
          )}
        </div>
        <Menu
          theme="light"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={handleMenuClick}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '16px 8px'
          }}
        />
      </Sider>
      <Layout style={{ background: 'transparent', overflow: 'hidden' }}>
        <Header
          style={{
            padding: '0 24px',
            background: 'rgba(255, 255, 255, 0.8)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #E5E7EB',
            height: 80,
          }}
        >
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            style={{
              fontSize: '18px',
              width: 40,
              height: 40,
              color: '#4B5563',
            }}
          />

          <Space size="large">
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: '#FFFBEB', /* Amber 50 */
              border: '1px solid #FCD34D', /* Amber 300 */
              padding: '6px 16px',
              borderRadius: '20px',
              cursor: 'pointer'
            }} onClick={() => navigate('/coins')}>
              <DollarOutlined style={{ color: '#D97706' }} />
              <Text style={{ color: '#D97706', fontWeight: 600 }}>¥{coinBalance.toFixed(2)}</Text>
            </div>

            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
              <Space style={{ cursor: 'pointer', padding: '4px 8px', borderRadius: '8px', transition: 'background 0.2s' }} className="user-dropdown">
                <Avatar
                  style={{
                    backgroundColor: '#4F46E5',
                    verticalAlign: 'middle',
                    border: '2px solid #E0E7FF'
                  }}
                  icon={<UserOutlined />}
                />
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <Text style={{ color: '#111827', fontWeight: 500 }}>{user?.username}</Text>
                  <Text style={{ color: '#6B7280', fontSize: 11 }}>{user?.role?.toUpperCase()}</Text>
                </div>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content
          style={{
            margin: isMobile ? '8px' : '24px',
            marginBottom: isMobile ? '60px' : '24px',
            background: 'transparent',
            overflowY: 'auto',
            overflowX: 'hidden',
            flex: 1,
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
