import React, { useState } from 'react';
import { Form, Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined, GlobalOutlined } from '@ant-design/icons';
import { useAuth } from '../../contexts/AuthContext';
import type { LoginRequest } from '../../types';
import { useNavigate, useLocation } from 'react-router-dom';
import EmailBindingModal from './EmailBindingModal';
import LoginVerificationModal from './LoginVerificationModal';
import { authApi } from '../../services/api';

const LoginForm: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // 邮箱绑定弹窗
  const [emailBindingVisible, setEmailBindingVisible] = useState(false);
  const [bindingUserId, setBindingUserId] = useState<number>(0);
  const [bindingEmail, setBindingEmail] = useState('');

  // 登录验证弹窗
  const [verificationVisible, setVerificationVisible] = useState(false);
  const [verificationUserId, setVerificationUserId] = useState<number>(0);
  const [verificationEmail, setVerificationEmail] = useState('');
  const [pendingUsername, setPendingUsername] = useState('');
  const [pendingPassword, setPendingPassword] = useState('');

  const redirectPath = (location.state as any)?.from?.pathname || '/dashboard';

  const handleSubmit = async (values: LoginRequest & { whitelabel_domain?: string }) => {
    const domain = String(values.whitelabel_domain ?? '').trim();
    if (domain) {
      localStorage.setItem('whitelabelDomain', domain);
    } else {
      localStorage.removeItem('whitelabelDomain');
    }

    setLoading(true);

    try {
      const response = await authApi.login(values);

      if (response.success && response.token && response.user) {
        // 登录成功
        await login(values);
        navigate(redirectPath, { replace: true });
      } else if (response.requireEmailBinding) {
        // 需要绑定邮箱
        setBindingUserId(response.userId!);
        setBindingEmail(response.email || '');
        setEmailBindingVisible(true);
      } else if (response.requireVerification) {
        // 需要验证码
        setVerificationUserId(response.userId!);
        setVerificationEmail(response.email!);
        setPendingUsername(values.username);
        setPendingPassword(values.password);
        setVerificationVisible(true);
      } else {
        message.error(response.error || '登录失败');
      }
    } catch (error: any) {
      const errorData = error.response?.data;

      if (errorData?.requireEmailBinding) {
        // 需要绑定邮箱
        setBindingUserId(errorData.userId);
        setBindingEmail(errorData.email || '');
        setEmailBindingVisible(true);
      } else if (errorData?.requireVerification) {
        // 需要验证码
        setVerificationUserId(errorData.userId);
        setVerificationEmail(errorData.email);
        setPendingUsername(values.username);
        setPendingPassword(values.password);
        setVerificationVisible(true);
      } else {
        message.error(errorData?.error || '登录失败');
      }
    } finally {
      setLoading(false);
    }
  };

  // 邮箱绑定成功后重新登录
  const handleEmailBindingSuccess = async () => {
    setEmailBindingVisible(false);
    message.success('邮箱绑定成功，请重新登录');
  };

  // 验证码验证成功后登录
  const handleVerificationSuccess = async (verificationCode: string) => {
    setVerificationVisible(false);
    setLoading(true);

    const success = await login({
      username: pendingUsername,
      password: pendingPassword,
      verificationCode,
    });

    setLoading(false);

    if (success) {
      navigate(redirectPath, { replace: true });
    }
  };

  return (
    <>
      <Form
        form={form}
        name="login"
        layout="vertical"
        onFinish={handleSubmit}
        autoComplete="off"
        size="large"
      >
        <Form.Item
          name="username"
          label={<span style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>用户名</span>}
          rules={[
            { required: true, message: '请输入用户名' },
            { min: 3, message: '用户名至少3个字符' },
          ]}
          style={{ marginBottom: '16px' }}
        >
          <Input
            prefix={<UserOutlined style={{ color: '#9CA3AF' }} />}
            placeholder="请输入用户名"
            style={{ height: '46px', borderRadius: '8px', fontSize: '15px' }}
          />
        </Form.Item>

        <Form.Item
          name="password"
          label={<span style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>密码</span>}
          rules={[
            { required: true, message: '请输入密码' },
            { min: 6, message: '密码至少6个字符' },
          ]}
          style={{ marginBottom: '24px' }}
        >
          <Input.Password
            prefix={<LockOutlined style={{ color: '#9CA3AF' }} />}
            placeholder="请输入密码"
            style={{ height: '46px', borderRadius: '8px', fontSize: '15px' }}
          />
        </Form.Item>

        <Form.Item
          name="whitelabel_domain"
          initialValue={localStorage.getItem('whitelabelDomain') || ''}
          style={{ marginBottom: '20px' }}
        >
          <Input
            prefix={<GlobalOutlined style={{ color: '#9CA3AF' }} />}
            placeholder="白标域名（默认站点可留空）"
            style={{ height: '44px', borderRadius: '8px', fontSize: '14px' }}
          />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            style={{
              width: '100%',
              height: '46px',
              borderRadius: '8px',
              fontSize: '16px',
              fontWeight: 600,
              background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
              border: 'none',
              boxShadow: '0 4px 12px rgba(79, 70, 229, 0.3)',
            }}
          >
            登录
          </Button>
        </Form.Item>
      </Form>

      {/* 邮箱绑定弹窗 */}
      <EmailBindingModal
        visible={emailBindingVisible}
        userId={bindingUserId}
        defaultEmail={bindingEmail}
        onSuccess={handleEmailBindingSuccess}
        onCancel={() => setEmailBindingVisible(false)}
      />

      {/* 登录验证弹窗 */}
      <LoginVerificationModal
        visible={verificationVisible}
        userId={verificationUserId}
        email={verificationEmail}
        username={pendingUsername}
        password={pendingPassword}
        onSuccess={handleVerificationSuccess}
        onCancel={() => setVerificationVisible(false)}
      />
    </>
  );
};

export default LoginForm;
