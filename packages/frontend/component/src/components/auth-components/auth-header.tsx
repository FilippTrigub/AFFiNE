import clsx from 'clsx';
import type { FC } from 'react';

import { BrandLogoIcon } from '../brand-logo';
import { authHeaderWrapper } from './share.css';

export const AuthHeader: FC<{
  title: string;
  subTitle?: string;
  className?: string;
}> = ({ title, subTitle, className }) => {
  return (
    <div className={clsx(authHeaderWrapper, className)}>
      <p>
        <BrandLogoIcon className="logo" />
        {title}
      </p>
      <p>{subTitle}</p>
    </div>
  );
};
